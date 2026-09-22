import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { and, eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { track } from "../analytics/amplitude.js";
import { assertCanCreateMeeting, type QuotaErrorBody } from "../billing/quota.js";
import { orgScopeById } from "../billing/scope.js";
import { config } from "../config.js";
import { db } from "../db/client.js";
import { audioObjects, integrations, meetingTemplates, meetings, user as userTable } from "../db/schema/index.js";
import { PROVIDER_TITLES, type IntegrationProvider } from "../db/schema/integrations.js";
import { UNCLASSIFIED_TEMPLATE_CODE } from "../db/seed.js";
import type { Participant } from "../db/types.js";
import { MEET_TRANSCRIPT_FIELD } from "../llm/speakers.js";
import { logger } from "../logger.js";
import { captureError } from "../observability/sentry.js";
import { extractAudioToM4a, probeDuration, withTempDir } from "../pipeline/audio.js";
import { enqueueIntegrationsSync, enqueueNotify, enqueueProcessMeeting, type IntegrationsSyncJob } from "../queue/boss.js";
import { objectKey, putObject } from "../storage/s3.js";
import { decryptSecret, encryptSecret, integrationsKey } from "./crypto.js";
import * as google from "./google-meet.js";
import { IntegrationError } from "./http.js";
import * as zoom from "./zoom.js";

/**
 * Синхронизация штатных записей Meet и Zoom: находим новые записи, тащим звук в bucket и отдаём
 * обычному пайплайну (как импорт файла из приложения). Дедупликация — meetings.external_ref.
 */

export type Integration = typeof integrations.$inferSelect;

/** На сколько заглядывать назад от прошлой синхронизации (и от «сейчас» при первой) */
const LOOKBACK_MS = 24 * 60 * 60 * 1000;

export interface SyncResult {
  imported: number;
  skipped: number;
  /** Что показать пользователю в карточке интеграции (последний пропуск), иначе null */
  note: string | null;
}

const empty = (): SyncResult => ({ imported: 0, skipped: 0, note: null });

/** Токен доступа: обновляем по refresh-токену, если истёк (Zoom при этом выдаёт новый refresh) */
export async function accessTokenFor(i: Integration): Promise<string> {
  if (i.accessTokenEnc && i.tokenExpiresAt && i.tokenExpiresAt.getTime() - 60_000 > Date.now()) return decryptSecret(i.accessTokenEnc);
  const refresh = decryptSecret(i.refreshTokenEnc);
  const t = i.provider === "google_meet" ? await google.refreshGoogleToken(refresh) : await zoom.refreshZoomToken(refresh);
  await db()
    .update(integrations)
    .set({
      accessTokenEnc: encryptSecret(t.accessToken),
      tokenExpiresAt: t.expiresAt,
      ...(t.refreshToken ? { refreshTokenEnc: encryptSecret(t.refreshToken) } : {}),
      status: "active",
    })
    .where(eq(integrations.id, i.id));
  return t.accessToken;
}

export const authExpiredText = (provider: IntegrationProvider): string => `Подключение к ${PROVIDER_TITLES[provider]} истекло — подключите заново`;

async function unclassifiedTemplate() {
  const [t] = await db()
    .select()
    .from(meetingTemplates)
    .where(and(eq(meetingTemplates.code, UNCLASSIFIED_TEMPLATE_CODE), eq(meetingTemplates.isActive, true)))
    .limit(1);
  if (!t) throw new Error("Системный шаблон «тип не выбран» не засеян (pnpm db:seed)");
  return t;
}

export interface ImportInput {
  integration: Integration;
  externalRef: string;
  title: string;
  platform: string;
  startedAt: Date;
  endedAt: Date | null;
  participantsHint: Participant[];
  /** Транскрипт платформы — подсказка шагу «кто есть кто» */
  meetTranscript?: string | null;
  /** Скачать исходник во временную папку; needsExtract — из видео нужно вынуть звук */
  download: (dir: string) => Promise<{ file: string; needsExtract: boolean }>;
}

/** imported — встреча создана; duplicate — уже импортирована; skipped — не хватило квоты; no_audio — нечего брать */
export type ImportOutcome = "imported" | "duplicate" | "skipped" | "no_audio";

/**
 * Импорт одной записи: дедупликация → квоты владельца интеграции → звук в bucket → очередь пайплайна.
 * Отказ по квоте не создаёт встречу: пользователю уходит push, а на следующем прогоне попробуем снова.
 */
export async function importRecording(input: ImportInput): Promise<ImportOutcome> {
  const d = db();
  const i = input.integration;
  const [dup] = await d.select({ id: meetings.id }).from(meetings).where(eq(meetings.externalRef, input.externalRef)).limit(1);
  if (dup) return "duplicate";

  try {
    await assertCanCreateMeeting({ userId: i.userId, org: await orgScopeById(i.organizationId) });
  } catch (e) {
    if (e instanceof HTTPException && e.status === 402) {
      const body = (await e.getResponse().json().catch(() => null)) as QuotaErrorBody | null;
      const text = `Запись ${PROVIDER_TITLES[i.provider]} не импортирована: ${e.message}`;
      await d.update(integrations).set({ lastError: text }).where(eq(integrations.id, i.id));
      await enqueueNotify({ kind: "import_skipped", userId: i.userId, text });
      track(i.userId, "integration_import_skipped", { provider: i.provider, code: body?.code ?? "quota" });
      logger.info({ provider: i.provider, externalRef: input.externalRef, code: body?.code ?? null }, "Импорт пропущен: квота");
      return "skipped";
    }
    throw e;
  }

  const template = await unclassifiedTemplate();
  const [owner] = await d.select({ agencyId: userTable.agencyId }).from(userTable).where(eq(userTable.id, i.userId)).limit(1);

  return withTempDir(`lakonik-import-${i.provider}-`, async (dir) => {
    const src = await input.download(dir);
    const audio = src.needsExtract ? join(dir, "audio.m4a") : src.file;
    if (src.needsExtract) await extractAudioToM4a(src.file, audio);
    const durationSec = await probeDuration(audio);
    const bytes = await readFile(audio);

    const [m] = await d
      .insert(meetings)
      .values({
        ownerId: i.userId,
        agencyId: owner?.agencyId ?? null,
        organizationId: i.organizationId,
        templateId: template.id,
        templateCode: template.code,
        templateVersion: template.version,
        title: input.title,
        status: "uploading",
        source: "imported",
        startedAt: input.startedAt,
        endedAt: input.endedAt,
        platform: input.platform,
        externalRef: input.externalRef,
        participantsHint: input.participantsHint,
        contextFields: input.meetTranscript ? { [MEET_TRANSCRIPT_FIELD]: input.meetTranscript } : {},
      })
      .onConflictDoNothing({ target: meetings.externalRef })
      .returning();
    if (!m) return "duplicate"; // параллельный прогон успел раньше

    const key = objectKey(m.id, "import", 0, "m4a");
    await putObject(key, bytes, "audio/mp4");
    await d
      .insert(audioObjects)
      .values({ meetingId: m.id, kind: "import", seq: 0, objectKey: key, contentType: "audio/mp4", sizeBytes: bytes.length, durationSec: durationSec?.toString(), uploadedAt: new Date() })
      .onConflictDoNothing();
    await d
      .update(meetings)
      .set({
        status: "queued",
        statusDetail: "В очереди",
        segmentCount: 1,
        durationSec: durationSec ? Math.round(durationSec) : null,
        endedAt: input.endedAt ?? (durationSec ? new Date(input.startedAt.getTime() + durationSec * 1000) : new Date()),
      })
      .where(eq(meetings.id, m.id));
    await enqueueProcessMeeting({ meetingId: m.id });
    track(i.userId, "integration_import", { provider: i.provider });
    logger.info({ meetingId: m.id, provider: i.provider, externalRef: input.externalRef, durationSec }, "Запись импортирована");
    return "imported";
  });
}

// ---------- Google Meet ----------

async function syncGoogle(i: Integration): Promise<SyncResult> {
  const token = await accessTokenFor(i);
  const since = new Date((i.lastSyncAt?.getTime() ?? Date.now()) - LOOKBACK_MS);
  const records = await google.listConferenceRecords(token, since);
  const res = empty();
  const codeCache = new Map<string, string | null>();

  for (const rec of records) {
    const recordings = await google.listRecordings(token, rec.name);
    if (!recordings.length) continue;
    const participants = await google.listParticipants(token, rec.name).catch((e: Error) => {
      logger.debug({ err: e.message, conference: rec.name }, "Meet: участники недоступны");
      return [] as google.MeetParticipant[];
    });
    let meetTranscript: string | null = null;
    try {
      const entries = await google.loadTranscript(token, rec.name);
      if (entries.length) meetTranscript = google.formatMeetTranscript(entries, participants);
    } catch (e) {
      logger.debug({ err: (e as Error).message, conference: rec.name }, "Meet: транскрипт недоступен");
    }
    const space = rec.space ?? "";
    if (!codeCache.has(space)) codeCache.set(space, await google.meetingCodeOf(token, rec.space).catch(() => null));

    for (const r of recordings) {
      const endTime = rec.endTime ?? r.endTime;
      const outcome = await importRecording({
        integration: i,
        externalRef: google.googleExternalRef(r.name),
        title: google.meetTitle(rec.startTime ?? r.startTime, codeCache.get(space) ?? null),
        platform: "Google Meet",
        startedAt: new Date(rec.startTime ?? r.startTime ?? Date.now()),
        endedAt: endTime ? new Date(endTime) : null,
        participantsHint: google.participantsHint(participants),
        meetTranscript,
        download: async (dir) => {
          const file = join(dir, "recording.mp4");
          await google.downloadDriveFile(token, r.fileId, file);
          return { file, needsExtract: true };
        },
      });
      if (outcome === "imported") res.imported++;
      if (outcome === "skipped") {
        res.skipped++;
        res.note = `Запись ${PROVIDER_TITLES[i.provider]} не импортирована: закончились часы тарифа. Попробуем снова после обновления лимита.`;
        return res; // часы кончились — остальные записи ждут следующего прогона
      }
    }
  }
  return res;
}

// ---------- Zoom ----------

/** Импорт одной записи Zoom: из вебхука (свой download_token) или из опроса (токен OAuth) */
export async function importZoomMeeting(i: Integration, rec: zoom.ZoomMeetingRecording, apiToken: string, downloadToken?: string | null): Promise<ImportOutcome> {
  const file = zoom.pickAudioFile(rec.files);
  if (!file) {
    logger.info({ uuid: rec.uuid }, "Zoom: в записи нет аудио-дорожки M4A");
    return "no_audio";
  }
  const participants = await zoom.zoomParticipants(apiToken, rec.uuid).catch((e: Error) => {
    logger.debug({ err: e.message, uuid: rec.uuid }, "Zoom: участники недоступны");
    return [] as Participant[];
  });
  return importRecording({
    integration: i,
    externalRef: zoom.zoomExternalRef(rec.uuid, file.id),
    title: zoom.zoomTitle(rec.topic, rec.startTime ?? file.recordingStart),
    platform: "Zoom",
    startedAt: new Date(rec.startTime ?? file.recordingStart ?? Date.now()),
    endedAt: file.recordingEnd ? new Date(file.recordingEnd) : null,
    participantsHint: participants,
    download: async (dir) => {
      const dest = join(dir, "recording.m4a");
      await zoom.downloadZoomFile(file.downloadUrl, downloadToken || apiToken, dest);
      return { file: dest, needsExtract: false };
    },
  });
}

async function syncZoom(i: Integration): Promise<SyncResult> {
  const token = await accessTokenFor(i);
  const from = new Date((i.lastSyncAt?.getTime() ?? Date.now()) - LOOKBACK_MS);
  const list = await zoom.listZoomRecordings(token, from);
  const res = empty();
  for (const rec of list) {
    const outcome = await importZoomMeeting(i, rec, token);
    if (outcome === "imported") res.imported++;
    if (outcome === "skipped") {
      res.skipped++;
      res.note = `Запись ${PROVIDER_TITLES[i.provider]} не импортирована: закончились часы тарифа. Попробуем снова после обновления лимита.`;
      return res;
    }
  }
  return res;
}

/** Вебхук recording.completed: находим интеграцию хоста и импортируем запись сразу */
export async function handleZoomRecordingCompleted(event: { payload?: unknown; download_token?: string }): Promise<ImportOutcome | "unknown_host" | "off"> {
  const payload = (event.payload ?? {}) as { object?: unknown };
  const rec = zoom.parseMeetingRecording(payload.object);
  if (!rec) return "unknown_host";
  const d = db();
  const rows = await d.select().from(integrations).where(and(eq(integrations.provider, "zoom"), eq(integrations.status, "active")));
  const host = rec.hostEmail?.toLowerCase() ?? null;
  const i = rows.find((x) => (rec.hostId && x.accountId === rec.hostId) || (host && x.accountEmail?.toLowerCase() === host));
  if (!i) {
    logger.info({ uuid: rec.uuid, hostEmail: host }, "Zoom: вебхук без подключённой интеграции");
    return "unknown_host";
  }
  if (!i.autoImport) return "off";
  const token = await accessTokenFor(i);
  const outcome = await importZoomMeeting(i, rec, token, event.download_token ?? null);
  await d.update(integrations).set({ lastSyncAt: new Date() }).where(eq(integrations.id, i.id));
  return outcome;
}

// ---------- Точки входа очереди ----------

export async function syncIntegration(integrationId: string): Promise<SyncResult> {
  const d = db();
  const [i] = await d.select().from(integrations).where(eq(integrations.id, integrationId)).limit(1);
  if (!i || i.status === "revoked") return empty();
  try {
    const res = i.provider === "google_meet" ? await syncGoogle(i) : await syncZoom(i);
    await d.update(integrations).set({ lastSyncAt: new Date(), status: "active", lastError: res.note }).where(eq(integrations.id, i.id));
    logger.info({ provider: i.provider, imported: res.imported, skipped: res.skipped }, "Интеграция синхронизирована");
    return res;
  } catch (e) {
    const err = e as Error;
    const expired = e instanceof IntegrationError && e.authExpired;
    const text = expired ? authExpiredText(i.provider) : `Не удалось синхронизировать ${PROVIDER_TITLES[i.provider]}: ${err.message}`;
    await d.update(integrations).set({ status: expired ? "error" : i.status, lastError: text }).where(eq(integrations.id, i.id));
    logger.warn({ provider: i.provider, err: err.message, expired }, "Синхронизация интеграции не удалась");
    if (!(e instanceof IntegrationError)) captureError(e, { integrationId: i.id, provider: i.provider });
    return empty();
  }
}

/** Поставить в очередь синхронизацию всех активных интеграций с авто-импортом */
export async function syncAllIntegrations(): Promise<number> {
  if (!integrationsKey()) {
    logger.debug("Интеграции выключены: нет INTEGRATIONS_KEY");
    return 0;
  }
  const rows = await db()
    .select({ id: integrations.id })
    .from(integrations)
    .where(and(eq(integrations.status, "active"), eq(integrations.autoImport, true)));
  for (const r of rows) await enqueueIntegrationsSync({ integrationId: r.id });
  return rows.length;
}

export async function runIntegrationsSync(job: IntegrationsSyncJob): Promise<void> {
  if (job.zoomRecording) {
    await handleZoomRecordingCompleted({ payload: job.zoomRecording.payload, download_token: job.zoomRecording.downloadToken });
    return;
  }
  if (job.integrationId) await syncIntegration(job.integrationId);
  else await syncAllIntegrations();
}

/** Расписание опроса провайдеров: INTEGRATIONS_SYNC_MINUTES */
export const integrationsCron = (): string => `*/${config().INTEGRATIONS_SYNC_MINUTES} * * * *`;
