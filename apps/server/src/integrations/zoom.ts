import { createHmac } from "node:crypto";
import { config } from "../config.js";
import { DEFAULT_TIMEZONE } from "../billing/entitlement.js";
import type { Participant } from "../db/types.js";
import { safeEqual } from "./crypto.js";
import { downloadToFile, fetchJson, IntegrationError, postForm } from "./http.js";

/**
 * Zoom: OAuth (user-managed приложение Marketplace), вебхук recording.completed и запасной опрос
 * users/me/recordings. Из записи берём аудио-дорожку M4A (audio_only) — видео нам не нужно.
 */

const AUTH_URL = "https://zoom.us/oauth/authorize";
const TOKEN_URL = "https://zoom.us/oauth/token";
const REVOKE_URL = "https://zoom.us/oauth/revoke";
const API = "https://api.zoom.us/v2";

export const ZOOM_SCOPES = ["recording:read", "user:read", "meeting:read"];

export const zoomRedirectUri = (): string => `${config().BASE_URL}/api/integrations/zoom/callback`;

export const zoomConfigured = (): boolean => !!config().ZOOM_CLIENT_ID && !!config().ZOOM_CLIENT_SECRET;

export function zoomAuthUrl(state: string): string {
  const q = new URLSearchParams({ response_type: "code", client_id: config().ZOOM_CLIENT_ID ?? "", redirect_uri: zoomRedirectUri(), state, scope: ZOOM_SCOPES.join(" ") });
  return `${AUTH_URL}?${q.toString()}`;
}

const basicAuth = (): string => `Basic ${Buffer.from(`${config().ZOOM_CLIENT_ID ?? ""}:${config().ZOOM_CLIENT_SECRET ?? ""}`).toString("base64")}`;

export interface ZoomTokens {
  accessToken: string;
  /** Zoom выдаёт новый refresh-токен при каждом обновлении — сохранять обязательно */
  refreshToken: string | null;
  expiresAt: Date | null;
  scopes: string[];
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
}

function tokensOf(r: TokenResponse): ZoomTokens {
  if (!r.access_token) throw new IntegrationError("Zoom: провайдер не вернул токен доступа", { retryable: false });
  return {
    accessToken: r.access_token,
    refreshToken: r.refresh_token ?? null,
    expiresAt: r.expires_in ? new Date(Date.now() + r.expires_in * 1000) : null,
    scopes: r.scope ? r.scope.split(" ").filter(Boolean) : [],
  };
}

export async function exchangeZoomCode(code: string): Promise<ZoomTokens> {
  const r = await postForm<TokenResponse>(TOKEN_URL, { grant_type: "authorization_code", code, redirect_uri: zoomRedirectUri() }, { what: "Zoom: обмен кода на токены", headers: { Authorization: basicAuth() } });
  return tokensOf(r);
}

export async function refreshZoomToken(refreshToken: string): Promise<ZoomTokens> {
  const r = await postForm<TokenResponse>(TOKEN_URL, { grant_type: "refresh_token", refresh_token: refreshToken }, { what: "Zoom: обновление токена", headers: { Authorization: basicAuth() } });
  return tokensOf(r);
}

export async function zoomAccount(accessToken: string): Promise<{ email: string | null; id: string | null }> {
  const r = await fetchJson<{ email?: string; id?: string }>(`${API}/users/me`, { what: "Zoom: данные аккаунта", headers: { Authorization: `Bearer ${accessToken}` } });
  return { email: r.email ?? null, id: r.id ?? null };
}

export async function revokeZoomToken(accessToken: string): Promise<void> {
  await postForm<unknown>(REVOKE_URL, { token: accessToken }, { what: "Zoom: отзыв доступа", headers: { Authorization: basicAuth() }, timeoutMs: 10_000 });
}

// ---------- Вебхук ----------

const hmacHex = (secret: string, message: string): string => createHmac("sha256", secret).update(message).digest("hex");

/** Подпись вебхука Zoom: v0=HMAC-SHA256(secret, "v0:<timestamp>:<тело как есть>") */
export const zoomSignature = (rawBody: string, timestamp: string, secret: string): string => `v0=${hmacHex(secret, `v0:${timestamp}:${rawBody}`)}`;

/** Проверка заголовков x-zm-signature и x-zm-request-timestamp (свежесть — 5 минут) */
export function verifyZoomWebhook(opts: { rawBody: string; timestamp: string | null; signature: string | null; secret: string; now?: Date; maxAgeSec?: number }): boolean {
  const { rawBody, timestamp, signature, secret, now = new Date(), maxAgeSec = 5 * 60 } = opts;
  if (!timestamp || !signature || !secret) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  if (Math.abs(now.getTime() / 1000 - ts) > maxAgeSec) return false;
  return safeEqual(signature, zoomSignature(rawBody, timestamp, secret));
}

/** Ответ на событие endpoint.url_validation */
export const zoomUrlValidation = (plainToken: string, secret: string): { plainToken: string; encryptedToken: string } => ({
  plainToken,
  encryptedToken: hmacHex(secret, plainToken),
});

// ---------- Записи ----------

export interface ZoomRecordingFile {
  id: string;
  fileType: string;
  recordingType: string;
  status: string;
  downloadUrl: string;
  fileSize: number;
  recordingStart: string | null;
  recordingEnd: string | null;
}

export interface ZoomMeetingRecording {
  uuid: string;
  meetingId: string;
  topic: string | null;
  startTime: string | null;
  hostEmail: string | null;
  hostId: string | null;
  files: ZoomRecordingFile[];
}

type Json = Record<string, unknown>;
const arr = (v: unknown): Json[] => (Array.isArray(v) ? (v as Json[]) : []);
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : v != null && typeof v === "number" ? String(v) : null);

export function parseRecordingFiles(json: unknown): ZoomRecordingFile[] {
  return arr((json as Json)?.recording_files)
    .map((f) => ({
      id: str(f.id) ?? "",
      fileType: (str(f.file_type) ?? "").toUpperCase(),
      recordingType: str(f.recording_type) ?? "",
      status: (str(f.status) ?? "completed").toLowerCase(),
      downloadUrl: str(f.download_url) ?? "",
      fileSize: typeof f.file_size === "number" ? f.file_size : 0,
      recordingStart: str(f.recording_start),
      recordingEnd: str(f.recording_end),
    }))
    .filter((f) => !!f.id && !!f.downloadUrl);
}

export function parseMeetingRecording(json: unknown): ZoomMeetingRecording | null {
  const o = (json ?? {}) as Json;
  const uuid = str(o.uuid);
  if (!uuid) return null;
  return {
    uuid,
    meetingId: str(o.id) ?? "",
    topic: str(o.topic),
    startTime: str(o.start_time),
    hostEmail: str(o.host_email),
    hostId: str(o.host_id),
    files: parseRecordingFiles(o),
  };
}

export function parseRecordingsList(json: unknown): ZoomMeetingRecording[] {
  return arr((json as Json)?.meetings)
    .map((m) => parseMeetingRecording(m))
    .filter((m): m is ZoomMeetingRecording => !!m);
}

/** Аудио-дорожка встречи: готовый M4A (audio_only). Видео не берём — в пайплайн идёт только звук */
export function pickAudioFile(files: ZoomRecordingFile[]): ZoomRecordingFile | null {
  const ready = files.filter((f) => f.status === "completed" || f.status === "");
  return (
    ready.find((f) => f.fileType === "M4A" && f.recordingType === "audio_only") ??
    ready.find((f) => f.fileType === "M4A") ??
    null
  );
}

export const zoomExternalRef = (uuid: string, fileId: string): string => `zoom:${uuid}:${fileId}`;

export function zoomTitle(topic: string | null, startTime: string | null): string {
  const when = startTime ? new Date(startTime).toLocaleString("ru-RU", { timeZone: DEFAULT_TIMEZONE, dateStyle: "short", timeStyle: "short" }) : null;
  return [topic?.trim() || "Zoom", when].filter(Boolean).join(" · ");
}

export function zoomParticipantsHint(json: unknown): Participant[] {
  const seen = new Set<string>();
  const out: Participant[] = [];
  for (const p of arr((json as Json)?.participants)) {
    const name = (str(p.name) ?? "").trim();
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.push({ name, role: null, company: null, side: "unknown" });
    if (out.length >= 20) break;
  }
  return out;
}

/** uuid встречи в пути кодируется дважды, если начинается с «/» или содержит «//» (требование Zoom) */
export function encodeMeetingUuid(uuid: string): string {
  const once = encodeURIComponent(uuid);
  return uuid.startsWith("/") || uuid.includes("//") ? encodeURIComponent(once) : once;
}

const ymd = (d: Date): string => d.toISOString().slice(0, 10);

export async function listZoomRecordings(accessToken: string, from: Date): Promise<ZoomMeetingRecording[]> {
  const q = new URLSearchParams({ from: ymd(from), page_size: "30" });
  const json = await fetchJson<unknown>(`${API}/users/me/recordings?${q.toString()}`, { what: "Zoom: список записей", headers: { Authorization: `Bearer ${accessToken}` } });
  return parseRecordingsList(json);
}

/** Участники завершённой встречи — best effort: на бесплатных планах эндпоинт может быть недоступен */
export async function zoomParticipants(accessToken: string, uuid: string): Promise<Participant[]> {
  const json = await fetchJson<unknown>(`${API}/past_meetings/${encodeMeetingUuid(uuid)}/participants?page_size=100`, {
    what: "Zoom: участники встречи",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  return zoomParticipantsHint(json);
}

/**
 * Скачивание записи. Токен передаём заголовком (Zoom принимает и download_token из вебхука, и токен OAuth) —
 * так он не попадает в URL и в логи.
 */
export async function downloadZoomFile(downloadUrl: string, token: string, dest: string): Promise<number> {
  return downloadToFile(downloadUrl, dest, { what: "Zoom: скачивание записи", headers: { Authorization: `Bearer ${token}` } });
}
