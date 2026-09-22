import { and, desc, eq, isNull } from "drizzle-orm";
import { track } from "../analytics/amplitude.js";
import { captureError } from "../observability/sentry.js";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { db } from "../db/client.js";
import { audioObjects, meetingTemplates, meetings, organizations, reports, transcripts, usageEvents } from "../db/schema/index.js";
import { logger } from "../logger.js";
import { deleteObjects, getObjectBytes, objectKey, presignGet, putObject } from "../storage/s3.js";
import { sttProvider, SttError } from "../stt/index.js";
import { summarizeTranscript, SummarizeError, type Effort } from "../llm/summarize.js";
import { analyzeSpeakers } from "../llm/speakers.js";
import { UNCLASSIFIED_TEMPLATE_CODE } from "../db/seed.js";
import { renderMarkdown } from "../export/markdown.js";
import { concatToM4a, probeDuration, withTempDir, writeTemp } from "./audio.js";
import { agencies } from "../db/schema/index.js";
import type { ProcessMeetingJob } from "../queue/boss.js";
import { config } from "../config.js";

/** url — ElevenLabs скачивает по presigned-ссылке; file — байты через multipart (localhost/MinIO недоступны извне). */
function sttUploadMode(): "url" | "file" {
  const cfg = config();
  if (cfg.STT_UPLOAD_MODE !== "auto") return cfg.STT_UPLOAD_MODE;
  const host = new URL(cfg.S3_PUBLIC_ENDPOINT ?? cfg.S3_ENDPOINT).hostname;
  return /^(localhost|127\.0\.0\.1|minio|.*\.local)$/.test(host) ? "file" : "url";
}
import { enqueueNotify } from "../queue/boss.js";
import { syncReportActionItems, syncTasksFromReport } from "../tasks/service.js";

type Meeting = typeof meetings.$inferSelect;
type Template = typeof meetingTemplates.$inferSelect;

export class PipelineError extends Error {
  constructor(
    message: string,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = "PipelineError";
  }
}

async function setStatus(meetingId: string, status: Meeting["status"], detail: string | null, error: string | null = null) {
  await db().update(meetings).set({ status, statusDetail: detail, error }).where(eq(meetings.id, meetingId));
}

async function loadMeeting(meetingId: string): Promise<{ meeting: Meeting; template: Template }> {
  const [meeting] = await db().select().from(meetings).where(eq(meetings.id, meetingId)).limit(1);
  if (!meeting) throw new PipelineError(`Встреча ${meetingId} не найдена`, false);
  const [template] = await db().select().from(meetingTemplates).where(eq(meetingTemplates.id, meeting.templateId)).limit(1);
  if (!template) throw new PipelineError(`Шаблон ${meeting.templateId} не найден`, false);
  return { meeting, template };
}

/** Шаг 1: склейка сегментов → merged.m4a в bucket. Идемпотентен: если merged уже есть — пропускаем. */
async function mergeStep(meeting: Meeting): Promise<{ key: string; durationSec: number | null }> {
  const d = db();
  const existingMerged = await d
    .select()
    .from(audioObjects)
    .where(and(eq(audioObjects.meetingId, meeting.id), eq(audioObjects.kind, "merged"), isNull(audioObjects.deletedAt)))
    .limit(1);
  if (existingMerged[0]) {
    return { key: existingMerged[0].objectKey, durationSec: existingMerged[0].durationSec ? Number(existingMerged[0].durationSec) : null };
  }

  const parts = await d
    .select()
    .from(audioObjects)
    .where(and(eq(audioObjects.meetingId, meeting.id), isNull(audioObjects.deletedAt)))
    .orderBy(audioObjects.kind, audioObjects.seq);
  const inputs = parts.filter((p) => (p.kind === "segment" || p.kind === "import") && p.uploadedAt);
  if (inputs.length === 0) throw new PipelineError("Нет загруженного аудио для встречи", false);

  await setStatus(meeting.id, "processing", `Подготовка аудио (${inputs.length} ч.)`);

  return withTempDir(`adv-${meeting.id}-`, async (dir) => {
    const files: string[] = [];
    for (const p of inputs) {
      const bytes = await getObjectBytes(p.objectKey);
      const ext = p.objectKey.split(".").pop() ?? "m4a";
      files.push(await writeTemp(dir, `${String(p.seq).padStart(4, "0")}.${ext}`, bytes));
    }
    const out = join(dir, "merged.m4a");
    await concatToM4a(files, out);
    const durationSec = await probeDuration(out);
    const key = objectKey(meeting.id, "merged");
    await putObject(key, await readFile(out), "audio/mp4");
    await d
      .insert(audioObjects)
      .values({ meetingId: meeting.id, kind: "merged", seq: 0, objectKey: key, contentType: "audio/mp4", durationSec: durationSec?.toString(), uploadedAt: new Date() })
      .onConflictDoNothing();
    if (durationSec && !meeting.durationSec) await d.update(meetings).set({ durationSec: Math.round(durationSec) }).where(eq(meetings.id, meeting.id));
    logger.info({ meetingId: meeting.id, parts: inputs.length, durationSec }, "Аудио склеено");
    return { key, durationSec };
  });
}

/** Шаг 2: транскрибация. Идемпотентен: если транскрипт есть — возвращаем его. */
async function transcribeStep(meeting: Meeting, mergedKey: string) {
  const d = db();
  const existing = await d.select().from(transcripts).where(eq(transcripts.meetingId, meeting.id)).limit(1);
  if (existing[0]) return existing[0];

  await setStatus(meeting.id, "transcribing", "Транскрибация");
  const keyterms: string[] = [];
  if (meeting.organizationId) {
    const [o] = await d.select({ settings: organizations.settings }).from(organizations).where(eq(organizations.id, meeting.organizationId)).limit(1);
    keyterms.push(...(o?.settings.keyterms ?? []));
  } else if (meeting.agencyId) {
    const [ag] = await d.select({ keyterms: agencies.keyterms }).from(agencies).where(eq(agencies.id, meeting.agencyId)).limit(1);
    if (ag) keyterms.push(...ag.keyterms);
  }
  for (const p of meeting.participantsHint) {
    keyterms.push(p.name);
    if (p.company) keyterms.push(p.company);
  }
  for (const v of Object.values(meeting.contextFields)) {
    if (typeof v === "string" && v.length < 50 && v.split(/\s+/).length <= 5) keyterms.push(v);
  }

  const useFile = sttUploadMode() === "file";
  const sourceUrl = useFile ? undefined : await presignGet(mergedKey, 2 * 60 * 60);
  const fileBytes = useFile ? await getObjectBytes(mergedKey) : undefined;
  let result;
  try {
    result = await sttProvider().transcribe({
      sourceUrl,
      fileBytes,
      fileName: "merged.m4a",
      contentType: "audio/mp4",
      numSpeakers: meeting.numSpeakersHint,
      language: meeting.languageHint,
      keyterms,
      correlationId: meeting.id,
    });
  } catch (e) {
    if (e instanceof SttError) throw new PipelineError(`Ошибка транскрибации: ${e.message}`, e.retryable);
    throw e;
  }

  if (result.wordCount < 5) {
    throw new PipelineError("В записи не распознана речь (тишина или слишком тихий звук). Проверьте микрофон и запишите заново.", false);
  }

  const [row] = await d
    .insert(transcripts)
    .values({
      meetingId: meeting.id,
      provider: result.provider,
      providerRequestId: result.providerRequestId,
      languageCode: result.languageCode,
      languageProbability: result.languageProbability?.toString(),
      fullText: result.fullText,
      segments: result.segments,
      speakers: {},
      audioDurationSec: result.audioDurationSec?.toString(),
      wordCount: result.wordCount,
      costUsd: result.costUsd.toString(),
    })
    .returning();
  await d.insert(usageEvents).values({
    meetingId: meeting.id,
    userId: meeting.ownerId,
    agencyId: meeting.agencyId,
    organizationId: meeting.organizationId,
    kind: "stt",
    provider: result.provider,
    amount: (result.audioDurationSec ?? 0).toString(),
    unit: "seconds",
    costUsd: result.costUsd.toString(),
    meta: { speakers: result.speakerIds.length, words: result.wordCount, language: result.languageCode },
  });
  if (result.audioDurationSec && !meeting.durationSec) {
    await d.update(meetings).set({ durationSec: Math.round(result.audioDurationSec) }).where(eq(meetings.id, meeting.id));
  }
  return row!;
}

/** Шаг 3: удаление всех аудио-объектов встречи из bucket. */
export async function purgeAudio(meetingId: string): Promise<number> {
  const d = db();
  const rows = await d.select().from(audioObjects).where(and(eq(audioObjects.meetingId, meetingId), isNull(audioObjects.deletedAt)));
  if (rows.length === 0) return 0;
  await deleteObjects(rows.map((r) => r.objectKey));
  await d.update(audioObjects).set({ deletedAt: new Date() }).where(and(eq(audioObjects.meetingId, meetingId), isNull(audioObjects.deletedAt)));
  logger.info({ meetingId, objects: rows.length }, "Аудио удалено из хранилища");
  return rows.length;
}

/** Шаг 3b: анализ спикеров (быстрая модель): кто есть кто, дубли диаризации. Предположения подтверждает пользователь.
 * Ошибка шага пайплайн не роняет — без подсказок можно работать. Идемпотентен: если подсказки уже есть — пропуск. */
async function analyzeSpeakersStep(meeting: Meeting) {
  const d = db();
  const [tr] = await d.select().from(transcripts).where(eq(transcripts.meetingId, meeting.id)).limit(1);
  if (!tr || tr.speakerSuggestions) return;
  await setStatus(meeting.id, "transcribing", "Определяем, кто есть кто");
  try {
    const { result, costUsd, usage } = await analyzeSpeakers(meeting, tr);
    await d.update(transcripts).set({ speakerSuggestions: result }).where(eq(transcripts.id, tr.id));
    await d.insert(usageEvents).values({
      meetingId: meeting.id,
      userId: meeting.ownerId,
      agencyId: meeting.agencyId,
      organizationId: meeting.organizationId,
      kind: "llm",
      provider: "anthropic",
      model: result.model,
      amount: (usage.input + usage.output).toString(),
      unit: "tokens",
      costUsd: costUsd.toString(),
      meta: { step: "speakers", ...usage, estimated: result.estimatedSpeakerCount },
    });
  } catch (e) {
    logger.warn({ meetingId: meeting.id, err: (e as Error).message }, "Анализ спикеров не удался — продолжаем без подсказок");
  }
}

/** Шаг 4: саммари → новая версия отчёта. */
async function summarizeStep(meeting: Meeting, template: Template, opts: { effort?: Effort; model?: string; createdBy: "pipeline" | "regenerate"; instructions?: string }) {
  const d = db();
  await setStatus(meeting.id, "summarizing", opts.instructions ? "Правка отчёта по инструкциям" : "Составление отчёта");
  const [tr] = await d.select().from(transcripts).where(eq(transcripts.meetingId, meeting.id)).limit(1);
  if (!tr) throw new PipelineError("Нет транскрипта для саммари", false);

  let previousMarkdown: string | undefined;
  if (opts.instructions) {
    const [prev] = await d.select({ markdown: reports.markdown }).from(reports).where(and(eq(reports.meetingId, meeting.id), eq(reports.isCurrent, true))).limit(1);
    previousMarkdown = prev?.markdown;
  }

  let res;
  try {
    res = await summarizeTranscript(template, meeting, tr, { effort: opts.effort, model: opts.model, instructions: opts.instructions, previousMarkdown });
  } catch (e) {
    if (e instanceof SummarizeError) throw new PipelineError(`Ошибка саммари: ${e.message}`, e.retryable);
    throw e;
  }

  const [last] = await d.select({ version: reports.version }).from(reports).where(eq(reports.meetingId, meeting.id)).orderBy(desc(reports.version)).limit(1);
  const version = (last?.version ?? 0) + 1;
  const o = res.output;

  const base = {
    meetingId: meeting.id,
    version,
    templateId: template.id,
    templateCode: template.code,
    templateVersion: template.version,
    model: res.model,
    effort: res.effort,
    title: o.title,
    summary: o.summary,
    participants: o.participants,
    sections: o.sections.map((s) => {
      const ts = template.reportSections.find((x) => x.key === s.key);
      return { key: s.key, heading: ts?.heading ?? s.key, content: s.content, internalOnly: ts?.internalOnly ?? false };
    }),
    actionItems: o.actionItems.map((a) => ({ ...a, done: false })),
    decisions: o.decisions,
    openQuestions: o.openQuestions,
    clientRequests: o.clientRequests,
    missingInfo: o.missingInfo,
    nextMeeting: o.nextMeeting,
    markdown: "",
    inputTokens: res.usage.input,
    outputTokens: res.usage.output,
    cacheReadTokens: res.usage.cacheRead,
    costUsd: res.costUsd.toString(),
    createdBy: opts.createdBy,
    isCurrent: true,
    instructions: opts.instructions ?? null,
  };
  const markdown = renderMarkdown(template, { ...base, id: "", createdAt: new Date(), updatedAt: new Date(), editedAt: null, editedBy: null } as unknown as typeof reports.$inferSelect, {
    startedAt: meeting.startedAt,
    durationSec: meeting.durationSec,
    platform: meeting.platform,
    templateTitle: template.title,
    confidentiality: meeting.confidentiality,
    includeInternal: true,
  });

  let inserted: typeof reports.$inferSelect | undefined;
  await d.transaction(async (tx) => {
    await tx.update(reports).set({ isCurrent: false }).where(eq(reports.meetingId, meeting.id));
    [inserted] = await tx.insert(reports).values({ ...base, markdown }).returning();
    await tx.insert(usageEvents).values({
      meetingId: meeting.id,
      userId: meeting.ownerId,
      agencyId: meeting.agencyId,
      organizationId: meeting.organizationId,
      kind: "llm",
      provider: "anthropic",
      model: res.model,
      amount: (res.usage.input + res.usage.output).toString(),
      unit: "tokens",
      costUsd: res.costUsd.toString(),
      meta: { ...res.usage, effort: res.effort, version },
    });
    const autoTitle = meeting.title === "" || meeting.title === template.title || /^Запись /.test(meeting.title);
    await tx
      .update(meetings)
      .set({ status: "done", statusDetail: null, error: null, ...(autoTitle ? { title: o.title } : {}) })
      .where(eq(meetings.id, meeting.id));
  });
  logger.info({ meetingId: meeting.id, version, model: res.model, costUsd: res.costUsd }, "Отчёт сохранён");
  if (inserted) {
    await syncTasksFromReport(meeting, inserted, base.actionItems);
    await syncReportActionItems(meeting.id);
  }
  return version;
}

/** Полный пайплайн: merge → transcribe → purge → summarize → notify. */
export async function processMeeting(job: ProcessMeetingJob): Promise<void> {
  const { meetingId } = job;
  let { meeting, template } = await loadMeeting(meetingId);
  const log = logger.child({ meetingId });

  if (job.templateId && job.templateId !== template.id) {
    const [t] = await db().select().from(meetingTemplates).where(eq(meetingTemplates.id, job.templateId)).limit(1);
    if (!t) throw new PipelineError("Шаблон для регенерации не найден", false);
    template = t;
    await db().update(meetings).set({ templateId: t.id, templateCode: t.code, templateVersion: t.version }).where(eq(meetings.id, meetingId));
    meeting = { ...meeting, templateId: t.id, templateCode: t.code, templateVersion: t.version };
  }

  try {
    const hasTranscript = (await db().select({ id: transcripts.id }).from(transcripts).where(eq(transcripts.meetingId, meetingId)).limit(1)).length > 0;
    if (!hasTranscript) {
      const { key } = await mergeStep(meeting);
      const refreshed = (await loadMeeting(meetingId)).meeting;
      await transcribeStep(refreshed, key);
      await purgeAudio(meetingId);
    } else {
      // Транскрипт есть — аудио точно больше не нужно
      await purgeAudio(meetingId);
    }
    await analyzeSpeakersStep((await loadMeeting(meetingId)).meeting);

    // Тип встречи могли выбрать во время записи или расшифровки — берём актуальный шаблон встречи
    const fresh = await loadMeeting(meetingId);
    const current = job.templateId ? template : fresh.template;
    if (current.code === UNCLASSIFIED_TEMPLATE_CODE) {
      // Быстрая запись без типа: расшифровка готова, отчёт строится после того, как пользователь подтвердит спикеров и выберет тип
      await setStatus(meetingId, "transcribed", "Расшифровка готова — проверьте спикеров и выберите тип встречи");
      track(fresh.meeting.ownerId, "transcript_ready", { durationSec: fresh.meeting.durationSec ?? null });
      await enqueueNotify({ meetingId, kind: "transcript_ready" });
      return;
    }
    await summarizeStep(fresh.meeting, current, { effort: job.effort, model: job.model, createdBy: job.regenerate ? "regenerate" : "pipeline", instructions: job.instructions?.trim() || undefined });
    track(fresh.meeting.ownerId, "report_ready", { template: current.code, regenerate: !!job.regenerate, model: job.model ?? "default" });
    await enqueueNotify({ meetingId, kind: "report_ready" });
  } catch (e) {
    const err = e as Error;
    const retryable = e instanceof PipelineError ? e.retryable : true;
    log.error({ err: err.message, retryable }, "Ошибка пайплайна");
    captureError(e, { meetingId, retryable: String(retryable) });
    if (!retryable) {
      await setStatus(meetingId, "failed", null, err.message);
      await enqueueNotify({ meetingId, kind: "failed" });
      return; // не ретраим
    }
    await setStatus(meetingId, "queued", "Повторная попытка", err.message);
    throw e; // pg-boss повторит
  }
}

/** Вызывается из DLQ: попытки исчерпаны. */
export async function markFailedFromDlq(job: ProcessMeetingJob, reason: string) {
  await setStatus(job.meetingId, "failed", null, `Обработка не удалась после нескольких попыток: ${reason}`);
  await enqueueNotify({ meetingId: job.meetingId, kind: "failed" });
}
