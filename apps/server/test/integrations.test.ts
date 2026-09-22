import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { decryptToken, encryptToken, parseKey, safeEqual } from "../src/integrations/crypto.js";
import { signState, verifyState } from "../src/integrations/state.js";
import {
  formatMeetTranscript,
  googleExternalRef,
  meetTitle,
  parseConferenceRecords,
  parseParticipants,
  parseRecordings,
  parseTranscriptEntries,
  participantsHint,
} from "../src/integrations/google-meet.js";
import {
  encodeMeetingUuid,
  parseMeetingRecording,
  parseRecordingsList,
  pickAudioFile,
  verifyZoomWebhook,
  zoomExternalRef,
  zoomParticipantsHint,
  zoomSignature,
  zoomTitle,
} from "../src/integrations/zoom.js";

/**
 * Интеграции Meet/Zoom: шифрование токенов, подпись state, подпись вебхука Zoom и разбор ответов
 * провайдеров по фикстурам. Реальные вызовы Google и Zoom тут не проверяются — для них нужны ключи.
 */

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): unknown => JSON.parse(readFileSync(join(here, "fixtures", name), "utf8"));

const KEY = parseKey("a".repeat(64))!;
const SECRET = "test-better-auth-secret-32-bytes!";
const WEBHOOK_SECRET = "zoom-webhook-secret";

describe("шифрование токенов интеграций", () => {
  it("ключ принимается в hex и base64, мусор — нет", () => {
    expect(parseKey("a".repeat(64))?.length).toBe(32);
    expect(parseKey(Buffer.alloc(32, 7).toString("base64"))?.length).toBe(32);
    expect(parseKey("короткий")).toBeNull();
    expect(parseKey("")).toBeNull();
    expect(parseKey(undefined)).toBeNull();
  });

  it("расшифровка возвращает исходный токен", () => {
    const token = "1//0gRefreshToken-Значение_с-Юникодом";
    const enc = encryptToken(token, KEY);
    expect(enc.startsWith("v1.")).toBe(true);
    expect(enc).not.toContain(token);
    expect(decryptToken(enc, KEY)).toBe(token);
  });

  it("каждый раз новый iv: два шифротекста одного токена различаются", () => {
    expect(encryptToken("x", KEY)).not.toBe(encryptToken("x", KEY));
  });

  it("чужой ключ и подделанный шифротекст не расшифровываются", () => {
    const enc = encryptToken("секрет", KEY);
    expect(() => decryptToken(enc, parseKey("b".repeat(64))!)).toThrow();
    const parts = enc.split(".");
    const broken = [parts[0], parts[1], parts[2], Buffer.from("подделка").toString("base64url")].join(".");
    expect(() => decryptToken(broken, KEY)).toThrow();
    expect(() => decryptToken("мусор", KEY)).toThrow();
  });

  it("сравнение подписей не падает на разной длине", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abcd")).toBe(false);
  });
});

describe("state OAuth", () => {
  const state = { userId: "user-1", organizationId: "org-1", provider: "google_meet" as const };

  it("подписывается и проверяется", async () => {
    const token = await signState(state, SECRET);
    expect(await verifyState(token, SECRET)).toMatchObject(state);
  });

  it("чужая подпись не проходит", async () => {
    const token = await signState(state, SECRET);
    await expect(verifyState(token, "другой-секрет-не-короче-32-байт!!")).rejects.toThrow();
  });

  it("просроченный state не проходит", async () => {
    const token = await signState(state, SECRET, -60);
    await expect(verifyState(token, SECRET)).rejects.toThrow();
  });
});

describe("вебхук Zoom", () => {
  const body = JSON.stringify({ event: "recording.completed" });
  const ts = "1790000000";
  const now = new Date(1790000000 * 1000);

  it("подпись считается по «v0:<timestamp>:<тело>»", () => {
    expect(zoomSignature(body, ts, WEBHOOK_SECRET)).toBe("v0=ea3956e40dd92cb058e15abbf8cb4a07ecfefcc3e94d2529aeb9b607a34bb535");
  });

  it("верная подпись принимается, изменённое тело — нет", () => {
    const signature = zoomSignature(body, ts, WEBHOOK_SECRET);
    expect(verifyZoomWebhook({ rawBody: body, timestamp: ts, signature, secret: WEBHOOK_SECRET, now })).toBe(true);
    expect(verifyZoomWebhook({ rawBody: `${body} `, timestamp: ts, signature, secret: WEBHOOK_SECRET, now })).toBe(false);
    expect(verifyZoomWebhook({ rawBody: body, timestamp: ts, signature: "v0=00", secret: WEBHOOK_SECRET, now })).toBe(false);
    expect(verifyZoomWebhook({ rawBody: body, timestamp: null, signature, secret: WEBHOOK_SECRET, now })).toBe(false);
  });

  it("старше пяти минут — отклоняется (защита от повтора)", () => {
    const signature = zoomSignature(body, ts, WEBHOOK_SECRET);
    const later = new Date((1790000000 + 6 * 60) * 1000);
    expect(verifyZoomWebhook({ rawBody: body, timestamp: ts, signature, secret: WEBHOOK_SECRET, now: later })).toBe(false);
  });

  it("ответ на endpoint.url_validation — HMAC от plainToken", async () => {
    const { zoomUrlValidation } = await import("../src/integrations/zoom.js");
    expect(zoomUrlValidation("abc123", WEBHOOK_SECRET)).toEqual({
      plainToken: "abc123",
      encryptedToken: "838b8e5cd11c0f36947018593c6d59b7b122dc9b66374c3a54aed054d0cef32d",
    });
  });
});

describe("разбор ответов Google Meet", () => {
  it("конференции: записи без name отбрасываются", () => {
    const records = parseConferenceRecords(fixture("meet-conference-records.json"));
    expect(records.map((r) => r.name)).toEqual(["conferenceRecords/abc-123", "conferenceRecords/def-456"]);
    expect(records[0]).toMatchObject({ startTime: "2026-09-22T09:00:00.000Z", space: "spaces/space-1" });
    expect(records[1]!.endTime).toBeNull();
  });

  it("записи: только FILE_GENERATED с файлом в Drive", () => {
    const recordings = parseRecordings(fixture("meet-recordings.json"));
    expect(recordings).toHaveLength(1);
    expect(recordings[0]).toMatchObject({ name: "conferenceRecords/abc-123/recordings/rec-1", fileId: "1AbCdEfGhIjKlMnOpQrStUvWxYz" });
  });

  it("участники: имя берётся у вошедшего, гостя или телефона, дубли не повторяются", () => {
    const participants = parseParticipants(fixture("meet-participants.json"));
    expect(participants).toHaveLength(4);
    expect(participants.map((p) => p.displayName)).toEqual(["Асель Нурланова", "Гость", "+7 701 000 00 00", "Асель Нурланова"]);
    const hint = participantsHint(participants);
    expect(hint.map((p) => p.name)).toEqual(["Асель Нурланова", "Гость", "+7 701 000 00 00"]);
    expect(hint[0]).toMatchObject({ side: "unknown", role: null, company: null });
  });

  it("транскрипт: реплики с именами и временем от начала", () => {
    const entries = parseTranscriptEntries(fixture("meet-transcript-entries.json"));
    expect(entries).toHaveLength(2); // пустой текст отброшен
    const text = formatMeetTranscript(entries, parseParticipants(fixture("meet-participants.json")));
    expect(text).toBe("[00:00] Асель Нурланова: Давайте начнём с бюджета кампании.\n[01:05] Гость: Смета выросла на двенадцать процентов.");
  });

  it("длинный транскрипт обрезается", () => {
    const entries = Array.from({ length: 500 }, (_, i) => ({ participant: null, text: `реплика номер ${i}`, startTime: null }));
    const text = formatMeetTranscript(entries, [], 200);
    expect(text.length).toBeLessThan(260);
    expect(text.endsWith("… (обрезано)")).toBe(true);
  });

  it("название и ключ дедупликации", () => {
    expect(googleExternalRef("conferenceRecords/abc-123/recordings/rec-1")).toBe("google_meet:conferenceRecords/abc-123/recordings/rec-1");
    const title = meetTitle("2026-09-22T09:00:00.000Z", "abc-defg-hij");
    expect(title).toContain("Google Meet · abc-defg-hij · ");
    expect(title).toContain("22.09.2026"); // время — по Алматы
    expect(title).toContain("14:00");
    expect(meetTitle(null, null)).toBe("Google Meet");
  });
});

describe("разбор записей Zoom", () => {
  const event = fixture("zoom-recording-completed.json") as { payload: { object: unknown }; download_token: string };

  it("из recording_files берётся аудио M4A", () => {
    const rec = parseMeetingRecording(event.payload.object)!;
    expect(rec.files.map((f) => f.id)).toEqual(["file-mp4", "file-m4a", "file-vtt"]);
    const audio = pickAudioFile(rec.files)!;
    expect(audio.id).toBe("file-m4a");
    expect(audio.downloadUrl).toBe("https://zoom.us/rec/download/m4a");
  });

  it("без аудио-дорожки — null", () => {
    const rec = parseMeetingRecording(event.payload.object)!;
    expect(pickAudioFile(rec.files.filter((f) => f.fileType !== "M4A"))).toBeNull();
    expect(pickAudioFile([])).toBeNull();
  });

  it("список записей и данные хоста", () => {
    const list = parseRecordingsList({ meetings: [event.payload.object] });
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ uuid: "aBcDeF/gHiJ==", meetingId: "81234567890", hostEmail: "Asel@advgroup.kz", hostId: "host-42", topic: "Статус по кампании" });
    expect(parseMeetingRecording({})).toBeNull();
  });

  it("название и ключ дедупликации", () => {
    const rec = parseMeetingRecording(event.payload.object)!;
    expect(zoomExternalRef(rec.uuid, "file-m4a")).toBe("zoom:aBcDeF/gHiJ==:file-m4a");
    const title = zoomTitle(rec.topic, rec.startTime);
    expect(title).toContain("Статус по кампании · ");
    expect(title).toContain("22.09.2026");
    expect(zoomTitle(null, null)).toBe("Zoom");
  });

  it("uuid кодируется дважды, только если начинается с «/» или содержит «//» (правило Zoom)", () => {
    expect(encodeMeetingUuid("/abc==")).toBe(encodeURIComponent(encodeURIComponent("/abc==")));
    expect(encodeMeetingUuid("ab//cd==")).toBe(encodeURIComponent(encodeURIComponent("ab//cd==")));
    expect(encodeMeetingUuid("aBcDeF/gHiJ==")).toBe(encodeURIComponent("aBcDeF/gHiJ=="));
    expect(encodeMeetingUuid("abcDEF123==")).toBe(encodeURIComponent("abcDEF123=="));
  });

  it("участники без дублей и пустых имён", () => {
    const hint = zoomParticipantsHint(fixture("zoom-participants.json"));
    expect(hint.map((p) => p.name)).toEqual(["Асель Нурланова", "Дмитрий Ким"]);
  });
});
