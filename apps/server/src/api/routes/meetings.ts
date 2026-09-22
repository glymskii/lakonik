import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { track } from "../../analytics/amplitude.js";
import { and, desc, eq, gt, ilike, inArray, isNull, or, sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { streamSSE } from "hono/streaming";
import { db } from "../../db/client.js";
import { audioObjects, meetingTemplates, meetings, reports, shares, transcripts, user as userTable } from "../../db/schema/index.js";
import { headObject, objectKey, presignPut } from "../../storage/s3.js";
import { enqueueProcessMeeting } from "../../queue/boss.js";
import { purgeAudio } from "../../pipeline/process-meeting.js";
import { UNCLASSIFIED_TEMPLATE_CODE } from "../../db/seed.js";
import { applySpeakerMerges } from "../../transcript/speakers.js";
import { assembleSections, renderDocx, renderMarkdown, renderPdf } from "../../export/index.js";
import { config } from "../../config.js";
import { logger } from "../../logger.js";
import { loadMeetingWithAccess, requireOwner, type Access } from "../authz.js";
import { currentTasks, getDeadlineSettings } from "../../tasks/service.js";
import { taskDto } from "./tasks.js";
import { requireUser, type AppEnv } from "../middleware/auth.js";
import {
  ActionItemsBody,
  CreateMeetingBody,
  ErrorSchema,
  FinalizeBody,
  IdParam,
  MeetingDetailSchema,
  MeetingSummarySchema,
  RegenerateBody,
  ReportEditBody,
  ReportSchema,
  SegmentCompleteBody,
  SegmentRequestBody,
  SegmentUploadSchema,
  ShareBody,
  ShareSchema,
  SpeakersBody,
  StatusEventSchema,
  UpdateMeetingBody,
} from "../schemas.js";

export const meetingsRoutes = new OpenAPIHono<AppEnv>();
meetingsRoutes.use("*", requireUser);

type Meeting = typeof meetings.$inferSelect;
type Template = typeof meetingTemplates.$inferSelect;
type Report = typeof reports.$inferSelect;

const iso = (d: Date | null) => (d ? d.toISOString() : null);

async function templateById(id: string): Promise<Template> {
  const [t] = await db().select().from(meetingTemplates).where(eq(meetingTemplates.id, id)).limit(1);
  if (!t) throw new HTTPException(404, { message: "Шаблон не найден" });
  return t;
}

/** Системный шаблон «тип не выбран» — для быстрой записи */
async function unclassifiedTemplate(): Promise<Template> {
  const [t] = await db().select().from(meetingTemplates).where(and(eq(meetingTemplates.code, UNCLASSIFIED_TEMPLATE_CODE), eq(meetingTemplates.isActive, true))).limit(1);
  if (!t) throw new HTTPException(500, { message: "Системный шаблон не засеян (pnpm db:seed)" });
  return t;
}

const autoTitleRe = /^Запись /;
function autoTitle(startedAt: Date, t: Template): string {
  const when = startedAt.toLocaleString("ru-RU", { timeZone: "Asia/Almaty", dateStyle: "short", timeStyle: "short" });
  return t.code === UNCLASSIFIED_TEMPLATE_CODE ? `Запись ${when}` : `Запись ${when} · ${t.title}`;
}

function summaryDto(m: Meeting, t: Template, flags: { hasTranscript: boolean; hasReport: boolean; isOwner: boolean }) {
  return {
    id: m.id,
    title: m.title,
    status: m.status,
    statusDetail: m.statusDetail,
    error: m.error,
    templateId: m.templateId,
    templateCode: m.templateCode,
    templateTitle: t.title,
    templateEmoji: t.emoji,
    group: t.group,
    source: m.source,
    confidentiality: m.confidentiality,
    startedAt: m.startedAt.toISOString(),
    endedAt: iso(m.endedAt),
    durationSec: m.durationSec,
    segmentCount: m.segmentCount,
    ...flags,
    createdAt: m.createdAt.toISOString(),
    updatedAt: m.updatedAt.toISOString(),
  };
}

function reportDto(r: Report, t: Template, includeInternal: boolean) {
  const sections = assembleSections(t, r).filter((s) => includeInternal || !s.internalOnly);
  return {
    id: r.id,
    version: r.version,
    templateId: r.templateId,
    templateCode: r.templateCode,
    reportTitle: t.reportTitle,
    model: r.model,
    effort: r.effort,
    title: r.title,
    summary: r.summary,
    participants: r.participants,
    sections,
    actionItems: r.actionItems,
    decisions: r.decisions,
    openQuestions: r.openQuestions,
    clientRequests: r.clientRequests,
    missingInfo: r.missingInfo,
    nextMeeting: r.nextMeeting ?? null,
    markdown: r.markdown,
    createdBy: r.createdBy,
    createdAt: r.createdAt.toISOString(),
    editedAt: r.editedAt ? r.editedAt.toISOString() : null,
  };
}

// ---------- Список ----------
meetingsRoutes.openapi(
  createRoute({
    method: "get",
    path: "/",
    tags: ["meetings"],
    summary: "Мои встречи (+ расшаренные со мной)",
    request: { query: z.object({ q: z.string().max(100).optional(), status: z.string().optional(), limit: z.coerce.number().int().min(1).max(100).default(50), offset: z.coerce.number().int().min(0).default(0) }) },
    responses: { 200: { description: "OK", content: { "application/json": { schema: z.object({ items: z.array(MeetingSummarySchema), total: z.number().int() }) } } } },
  }),
  async (c) => {
    const u = c.get("user");
    const { q, status, limit, offset } = c.req.valid("query");
    const d = db();
    const sharedIds = d
      .select({ id: shares.meetingId })
      .from(shares)
      .where(and(or(eq(shares.recipientUserId, u.id), eq(shares.recipientEmail, u.email.toLowerCase())), or(isNull(shares.expiresAt), gt(shares.expiresAt, new Date()))));
    const where = and(
      or(eq(meetings.ownerId, u.id), inArray(meetings.id, sharedIds)),
      q ? ilike(meetings.title, `%${q}%`) : undefined,
      status ? eq(meetings.status, status as Meeting["status"]) : undefined,
    );
    const rows = await d
      .select({
        m: meetings,
        t: meetingTemplates,
        hasTranscript: sql<boolean>`exists(select 1 from ${transcripts} where ${transcripts.meetingId} = ${meetings.id})`,
        hasReport: sql<boolean>`exists(select 1 from ${reports} where ${reports.meetingId} = ${meetings.id})`,
      })
      .from(meetings)
      .innerJoin(meetingTemplates, eq(meetingTemplates.id, meetings.templateId))
      .where(where)
      .orderBy(desc(meetings.startedAt))
      .limit(limit)
      .offset(offset);
    const totalRows = await d.select({ total: sql<number>`count(*)::int` }).from(meetings).where(where);
    return c.json({ items: rows.map((r) => summaryDto(r.m, r.t, { hasTranscript: r.hasTranscript, hasReport: r.hasReport, isOwner: r.m.ownerId === u.id })), total: totalRows[0]?.total ?? 0 }, 200);
  },
);

// ---------- Создание ----------
meetingsRoutes.openapi(
  createRoute({
    method: "post",
    path: "/",
    tags: ["meetings"],
    summary: "Создать встречу (перед началом записи)",
    request: { body: { content: { "application/json": { schema: CreateMeetingBody } } } },
    responses: { 201: { description: "Создано", content: { "application/json": { schema: MeetingSummarySchema } } }, 404: { description: "Шаблон не найден", content: { "application/json": { schema: ErrorSchema } } } },
  }),
  async (c) => {
    const u = c.get("user");
    const body = c.req.valid("json");
    const t = body.templateId ? await templateById(body.templateId) : await unclassifiedTemplate();
    const startedAt = body.startedAt ? new Date(body.startedAt) : new Date();
    const title = body.title?.trim() || autoTitle(startedAt, t);
    const confidentiality = t.confidentiality === "restricted" ? "restricted" : t.allowConfidentialityChoice && body.confidentiality ? body.confidentiality : "standard";
    const [m] = await db()
      .insert(meetings)
      .values({
        ownerId: u.id,
        agencyId: u.agencyId,
        templateId: t.id,
        templateCode: t.code,
        templateVersion: t.version,
        title,
        status: body.source === "imported" ? "uploading" : "recording",
        source: body.source,
        confidentiality,
        startedAt,
        contextFields: body.contextFields,
        participantsHint: body.participantsHint,
        numSpeakersHint: body.numSpeakersHint ?? null,
        languageHint: body.languageHint ?? null,
        platform: body.platform ?? null,
        deviceId: body.deviceId ?? null,
      })
      .returning();
    track(u.id, body.source === "imported" ? "file_imported" : "recording_started", { template: t.code, hasTemplate: t.code !== UNCLASSIFIED_TEMPLATE_CODE });
    return c.json(summaryDto(m!, t, { hasTranscript: false, hasReport: false, isOwner: true }), 201);
  },
);

// ---------- Детали ----------
async function detailDto(a: Access) {
  const d = db();
  const m = a.meeting;
  const t = await templateById(m.templateId);
  const [tr] = await d.select().from(transcripts).where(eq(transcripts.meetingId, m.id)).limit(1);
  const [cur] = await d.select().from(reports).where(and(eq(reports.meetingId, m.id), eq(reports.isCurrent, true))).limit(1);
  const versions = await d.select({ id: reports.id, version: reports.version, templateCode: reports.templateCode, createdAt: reports.createdAt, createdBy: reports.createdBy, instructions: reports.instructions }).from(reports).where(eq(reports.meetingId, m.id)).orderBy(desc(reports.version));
  const reportTemplate = cur ? (cur.templateId === t.id ? t : await templateById(cur.templateId)) : t;
  const includeInternal = a.scope === "full";
  const showTranscript = a.scope === "full" || a.scope === "report_transcript";
  const [taskRows, dl] = await Promise.all([currentTasks(m.id), getDeadlineSettings()]);
  const slaHours = t.group === "internal" ? dl.reportSlaInternalHours : dl.reportSlaExternalHours;
  const reportDueAt = new Date(m.startedAt.getTime() + slaHours * 3600 * 1000);
  return {
    tasks: taskRows.map((x) => ({ ...taskDto(x, m, t.emoji, ""), isOwner: a.isOwner })),
    reportDueAt: reportDueAt.toISOString(),
    reportSlaHours: slaHours,
    ...summaryDto(m, t, { hasTranscript: !!tr, hasReport: !!cur, isOwner: a.isOwner }),
    contextFields: m.contextFields,
    participantsHint: m.participantsHint,
    numSpeakersHint: m.numSpeakersHint,
    languageHint: m.languageHint,
    platform: m.platform,
    markers: m.markers,
    transcript:
      tr && showTranscript
        ? {
            id: tr.id,
            provider: tr.provider,
            languageCode: tr.languageCode,
            segments: tr.segments,
            speakers: tr.speakers,
            selfSpeakerId: tr.selfSpeakerId ?? null,
            speakerRoles: tr.speakerRoles ?? {},
            speakerIds: [...new Set(tr.segments.map((s) => s.speakerId))],
            speakerSuggestions: tr.speakerSuggestions ?? null,
            speakersConfirmed: !!tr.speakersConfirmedAt,
            audioDurationSec: tr.audioDurationSec ? Number(tr.audioDurationSec) : null,
            wordCount: tr.wordCount,
            createdAt: tr.createdAt.toISOString(),
          }
        : null,
    report: cur ? reportDto(cur, reportTemplate, includeInternal) : null,
    reportVersions: versions.map((v) => ({ ...v, createdAt: v.createdAt.toISOString() })),
  };
}

meetingsRoutes.openapi(
  createRoute({
    method: "get",
    path: "/{id}",
    tags: ["meetings"],
    summary: "Встреча с транскриптом и текущим отчётом",
    request: { params: IdParam },
    responses: { 200: { description: "OK", content: { "application/json": { schema: MeetingDetailSchema } } }, 404: { description: "Не найдено", content: { "application/json": { schema: ErrorSchema } } } },
  }),
  async (c) => {
    const a = await loadMeetingWithAccess(c.req.valid("param").id, c.get("user"));
    return c.json(await detailDto(a), 200);
  },
);

meetingsRoutes.openapi(
  createRoute({
    method: "patch",
    path: "/{id}",
    tags: ["meetings"],
    summary: "Обновить метаданные встречи (контекст, отметки, название)",
    request: { params: IdParam, body: { content: { "application/json": { schema: UpdateMeetingBody } } } },
    responses: { 200: { description: "OK", content: { "application/json": { schema: MeetingDetailSchema } } } },
  }),
  async (c) => {
    const a = await loadMeetingWithAccess(c.req.valid("param").id, c.get("user"));
    requireOwner(a);
    const body = c.req.valid("json");
    let t = await templateById(a.meeting.templateId);
    const patch: Partial<Meeting> = {};
    if (body.templateId !== undefined && body.templateId !== a.meeting.templateId) {
      // Смена типа: можно всегда, кроме момента, когда отчёт уже строится. Пайплайн берёт актуальный шаблон после расшифровки.
      if (a.meeting.status === "summarizing") throw new HTTPException(409, { message: "Отчёт уже строится — дождитесь окончания, потом можно пересобрать по другому типу" });
      t = await templateById(body.templateId);
      if (t.code === UNCLASSIFIED_TEMPLATE_CODE) throw new HTTPException(400, { message: "Выберите тип встречи" });
      patch.templateId = t.id;
      patch.templateCode = t.code;
      patch.templateVersion = t.version;
      if (t.confidentiality === "restricted") patch.confidentiality = "restricted";
      if (autoTitleRe.test(a.meeting.title) && body.title === undefined) patch.title = autoTitle(a.meeting.startedAt, t);
    }
    if (body.title !== undefined) patch.title = body.title.trim() || a.meeting.title;
    if (body.contextFields !== undefined) patch.contextFields = body.contextFields;
    if (body.participantsHint !== undefined) patch.participantsHint = body.participantsHint;
    if (body.numSpeakersHint !== undefined) patch.numSpeakersHint = body.numSpeakersHint;
    if (body.languageHint !== undefined) patch.languageHint = body.languageHint;
    if (body.platform !== undefined) patch.platform = body.platform;
    if (body.markers !== undefined) patch.markers = body.markers;
    if (body.confidentiality !== undefined && t.allowConfidentialityChoice) patch.confidentiality = body.confidentiality;
    await db().update(meetings).set(patch).where(eq(meetings.id, a.meeting.id));
    return c.json(await detailDto(await loadMeetingWithAccess(a.meeting.id, c.get("user"))), 200);
  },
);

meetingsRoutes.openapi(
  createRoute({
    method: "delete",
    path: "/{id}",
    tags: ["meetings"],
    summary: "Удалить встречу (транскрипт, отчёты, аудио)",
    request: { params: IdParam },
    responses: { 200: { description: "OK", content: { "application/json": { schema: z.object({ ok: z.boolean() }) } } } },
  }),
  async (c) => {
    const a = await loadMeetingWithAccess(c.req.valid("param").id, c.get("user"));
    requireOwner(a);
    await purgeAudio(a.meeting.id).catch((e) => logger.warn(e, "purge при удалении"));
    await db().delete(meetings).where(eq(meetings.id, a.meeting.id));
    track(c.get("user").id, "meeting_deleted", { status: a.meeting.status });
    return c.json({ ok: true }, 200);
  },
);

// ---------- Загрузка сегментов ----------
meetingsRoutes.openapi(
  createRoute({
    method: "post",
    path: "/{id}/segments",
    tags: ["upload"],
    summary: "Получить presigned PUT URL для сегмента аудио (или импортируемого файла)",
    request: { params: IdParam, body: { content: { "application/json": { schema: SegmentRequestBody } } } },
    responses: { 200: { description: "OK", content: { "application/json": { schema: SegmentUploadSchema } } }, 409: { description: "Встреча уже финализирована", content: { "application/json": { schema: ErrorSchema } } } },
  }),
  async (c) => {
    const a = await loadMeetingWithAccess(c.req.valid("param").id, c.get("user"));
    requireOwner(a);
    const body = c.req.valid("json");
    if (!["recording", "uploading", "failed"].includes(a.meeting.status)) throw new HTTPException(409, { message: "Загрузка для этой встречи закрыта" });
    const key = objectKey(a.meeting.id, body.kind, body.seq, body.extension);
    const expiresInSec = 15 * 60;
    const uploadUrl = await presignPut(key, body.contentType, expiresInSec);
    await db()
      .insert(audioObjects)
      .values({ meetingId: a.meeting.id, kind: body.kind, seq: body.seq, objectKey: key, contentType: body.contentType })
      .onConflictDoUpdate({ target: [audioObjects.meetingId, audioObjects.kind, audioObjects.seq], set: { objectKey: key, contentType: body.contentType, deletedAt: null } });
    return c.json({ seq: body.seq, objectKey: key, uploadUrl, expiresInSec, headers: { "Content-Type": body.contentType } }, 200);
  },
);

meetingsRoutes.openapi(
  createRoute({
    method: "post",
    path: "/{id}/segments/{seq}/complete",
    tags: ["upload"],
    summary: "Подтвердить загрузку сегмента",
    request: { params: IdParam.extend({ seq: z.coerce.number().int().min(0) }), body: { content: { "application/json": { schema: SegmentCompleteBody } } } },
    responses: { 200: { description: "OK", content: { "application/json": { schema: z.object({ ok: z.boolean(), sizeBytes: z.number().int().nullable(), segmentCount: z.number().int() }) } } }, 404: { description: "Объект не найден в хранилище", content: { "application/json": { schema: ErrorSchema } } } },
  }),
  async (c) => {
    const { id, seq } = c.req.valid("param");
    const a = await loadMeetingWithAccess(id, c.get("user"));
    requireOwner(a);
    const body = c.req.valid("json");
    const d = db();
    const [obj] = await d
      .select()
      .from(audioObjects)
      .where(and(eq(audioObjects.meetingId, id), eq(audioObjects.seq, seq), inArray(audioObjects.kind, ["segment", "import"]), isNull(audioObjects.deletedAt)))
      .limit(1);
    if (!obj) throw new HTTPException(404, { message: "Сегмент не зарегистрирован" });
    const head = await headObject(obj.objectKey);
    if (!head) throw new HTTPException(404, { message: "Файл не найден в хранилище — повторите загрузку" });
    await d.update(audioObjects).set({ uploadedAt: new Date(), sizeBytes: head.size, durationSec: body.durationSec?.toString() ?? null }).where(eq(audioObjects.id, obj.id));
    const cnt = await d
      .select({ n: sql<number>`count(*)::int` })
      .from(audioObjects)
      .where(and(eq(audioObjects.meetingId, id), isNull(audioObjects.deletedAt), sql`${audioObjects.uploadedAt} is not null`));
    const n = cnt[0]?.n ?? 0;
    await d.update(meetings).set({ segmentCount: n }).where(eq(meetings.id, id));
    return c.json({ ok: true, sizeBytes: head.size, segmentCount: n }, 200);
  },
);

// ---------- Финализация → очередь ----------
meetingsRoutes.openapi(
  createRoute({
    method: "post",
    path: "/{id}/finalize",
    tags: ["meetings"],
    summary: "Завершить запись и поставить в обработку",
    request: { params: IdParam, body: { content: { "application/json": { schema: FinalizeBody } } } },
    responses: { 200: { description: "OK", content: { "application/json": { schema: MeetingSummarySchema } } }, 409: { description: "Нет загруженного аудио", content: { "application/json": { schema: ErrorSchema } } } },
  }),
  async (c) => {
    const a = await loadMeetingWithAccess(c.req.valid("param").id, c.get("user"));
    requireOwner(a);
    const body = c.req.valid("json");
    const d = db();
    // Сегменты, для которых клиент не успел вызвать /complete (фоновая загрузка): проверяем наличие в bucket сами
    const pending = await d
      .select()
      .from(audioObjects)
      .where(and(eq(audioObjects.meetingId, a.meeting.id), isNull(audioObjects.deletedAt), isNull(audioObjects.uploadedAt)));
    for (const p of pending) {
      const head = await headObject(p.objectKey);
      if (head && head.size > 0) await d.update(audioObjects).set({ uploadedAt: new Date(), sizeBytes: head.size }).where(eq(audioObjects.id, p.id));
    }
    const uploaded = await d
      .select({ n: sql<number>`count(*)::int` })
      .from(audioObjects)
      .where(and(eq(audioObjects.meetingId, a.meeting.id), isNull(audioObjects.deletedAt), sql`${audioObjects.uploadedAt} is not null`));
    if ((uploaded[0]?.n ?? 0) === 0) throw new HTTPException(409, { message: "Нет загруженных сегментов аудио" });
    await d.update(meetings).set({ segmentCount: uploaded[0]?.n ?? 0 }).where(eq(meetings.id, a.meeting.id));
    const endedAt = body.endedAt ? new Date(body.endedAt) : new Date();
    const durationSec = body.durationSec ?? Math.max(0, Math.round((endedAt.getTime() - a.meeting.startedAt.getTime()) / 1000));
    const [m] = await d
      .update(meetings)
      .set({ status: "queued", statusDetail: "В очереди", error: null, endedAt, durationSec, ...(body.markers ? { markers: body.markers } : {}) })
      .where(eq(meetings.id, a.meeting.id))
      .returning();
    await enqueueProcessMeeting({ meetingId: a.meeting.id });
    const t = await templateById(m!.templateId);
    track(c.get("user").id, "recording_finished", { durationSec: durationSec ?? null, segments: m!.segmentCount, template: t.code });
    return c.json(summaryDto(m!, t, { hasTranscript: false, hasReport: false, isOwner: true }), 200);
  },
);

// ---------- Повтор после ошибки ----------
meetingsRoutes.openapi(
  createRoute({
    method: "post",
    path: "/{id}/retry",
    tags: ["meetings"],
    summary: "Повторить обработку после ошибки",
    request: { params: IdParam },
    responses: { 200: { description: "OK", content: { "application/json": { schema: MeetingSummarySchema } } } },
  }),
  async (c) => {
    const a = await loadMeetingWithAccess(c.req.valid("param").id, c.get("user"));
    requireOwner(a);
    if (!["failed", "queued", "done"].includes(a.meeting.status)) throw new HTTPException(409, { message: "Встреча уже обрабатывается" });
    const [m] = await db().update(meetings).set({ status: "queued", statusDetail: "В очереди", error: null }).where(eq(meetings.id, a.meeting.id)).returning();
    await enqueueProcessMeeting({ meetingId: a.meeting.id });
    const t = await templateById(m!.templateId);
    return c.json(summaryDto(m!, t, { hasTranscript: false, hasReport: false, isOwner: true }), 200);
  },
);

// ---------- SSE статуса ----------
meetingsRoutes.openapi(
  createRoute({
    method: "get",
    path: "/{id}/events",
    tags: ["meetings"],
    summary: "SSE-поток статуса обработки (событие status, закрывается на done/failed)",
    request: { params: IdParam },
    responses: { 200: { description: "text/event-stream", content: { "text/event-stream": { schema: StatusEventSchema } } } },
  }),
  async (c) => {
    const a = await loadMeetingWithAccess(c.req.valid("param").id, c.get("user"));
    const id = a.meeting.id;
    return streamSSE(c, async (stream) => {
      let last = "";
      const deadline = Date.now() + 30 * 60 * 1000;
      while (Date.now() < deadline && !stream.aborted) {
        const [m] = await db().select({ status: meetings.status, statusDetail: meetings.statusDetail, error: meetings.error, updatedAt: meetings.updatedAt }).from(meetings).where(eq(meetings.id, id)).limit(1);
        if (!m) break;
        const payload = JSON.stringify({ status: m.status, statusDetail: m.statusDetail, error: m.error, updatedAt: m.updatedAt.toISOString() });
        if (payload !== last) {
          await stream.writeSSE({ event: "status", data: payload, id: String(Date.now()) });
          last = payload;
        }
        if (m.status === "done" || m.status === "failed") break;
        await stream.sleep(2000);
      }
    });
  },
);

// ---------- Спикеры ----------
meetingsRoutes.openapi(
  createRoute({
    method: "patch",
    path: "/{id}/speakers",
    tags: ["transcript"],
    summary: "Переименовать спикеров транскрипта",
    request: { params: IdParam, body: { content: { "application/json": { schema: SpeakersBody } } } },
    responses: { 200: { description: "OK", content: { "application/json": { schema: MeetingDetailSchema } } } },
  }),
  async (c) => {
    const a = await loadMeetingWithAccess(c.req.valid("param").id, c.get("user"));
    requireOwner(a);
    const { speakers, selfSpeakerId, speakerRoles, merges, confirmed } = c.req.valid("json");
    const [tr] = await db().select().from(transcripts).where(eq(transcripts.meetingId, a.meeting.id)).limit(1);
    if (!tr) throw new HTTPException(409, { message: "Транскрипта ещё нет" });
    const cleaned = Object.fromEntries(Object.entries(speakers).map(([k, v]) => [k, v.trim()]).filter(([, v]) => v));
    const patch: Partial<typeof transcripts.$inferInsert> = { speakers: cleaned };
    if (speakerRoles !== undefined) patch.speakerRoles = speakerRoles;
    let self = selfSpeakerId !== undefined ? selfSpeakerId : tr.selfSpeakerId;
    if (merges && Object.keys(merges).length) {
      // Дубли диаризации: реплики «лишнего» спикера переходят к основному, его имя/роль/отметка «это я» — тоже
      const merged = applySpeakerMerges({ segments: tr.segments, speakers: cleaned, speakerRoles: patch.speakerRoles ?? tr.speakerRoles, selfSpeakerId: self }, merges);
      patch.segments = merged.segments;
      patch.speakers = merged.speakers;
      patch.speakerRoles = merged.speakerRoles;
      patch.fullText = merged.segments.map((s) => s.text).join(" ");
      self = merged.selfSpeakerId;
    }
    if (selfSpeakerId !== undefined || merges) {
      patch.selfSpeakerId = self;
      // Владелец записи: подставляем имя пользователя, если спикер ещё не назван; роль — коллега
      const me = c.get("user");
      if (self && !patch.speakers![self] && me.name?.trim()) patch.speakers = { ...patch.speakers, [self]: me.name.trim() };
      if (self) patch.speakerRoles = { ...(patch.speakerRoles ?? speakerRoles ?? tr.speakerRoles ?? {}), [self]: "ours" };
    }
    if (confirmed) { patch.speakersConfirmedAt = new Date(); track(c.get("user").id, "speakers_confirmed", { merges: Object.keys(merges ?? {}).length }); }
    await db().update(transcripts).set(patch).where(eq(transcripts.meetingId, a.meeting.id));
    return c.json(await detailDto(await loadMeetingWithAccess(a.meeting.id, c.get("user"))), 200);
  },
);

// ---------- Регенерация отчёта ----------
meetingsRoutes.openapi(
  createRoute({
    method: "post",
    path: "/{id}/reports",
    tags: ["reports"],
    summary: "Пересобрать отчёт (другой шаблон / после переименования спикеров / черновой режим)",
    request: { params: IdParam, body: { content: { "application/json": { schema: RegenerateBody } } } },
    responses: { 202: { description: "Поставлено в очередь", content: { "application/json": { schema: MeetingSummarySchema } } }, 409: { description: "Нет транскрипта", content: { "application/json": { schema: ErrorSchema } } } },
  }),
  async (c) => {
    const a = await loadMeetingWithAccess(c.req.valid("param").id, c.get("user"));
    requireOwner(a);
    const body = c.req.valid("json");
    const [tr] = await db().select({ id: transcripts.id }).from(transcripts).where(eq(transcripts.meetingId, a.meeting.id)).limit(1);
    if (!tr) throw new HTTPException(409, { message: "Транскрипта ещё нет" });
    if (!["done", "failed", "transcribed"].includes(a.meeting.status)) throw new HTTPException(409, { message: "Встреча уже обрабатывается" });
    const target = body.templateId ? await templateById(body.templateId) : await templateById(a.meeting.templateId);
    if (target.code === UNCLASSIFIED_TEMPLATE_CODE) throw new HTTPException(409, { message: "Сначала выберите тип встречи" });
    const first = a.meeting.status === "transcribed";
    const [m] = await db().update(meetings).set({ status: "queued", statusDetail: first ? "Составление отчёта" : "Пересборка отчёта", error: null }).where(eq(meetings.id, a.meeting.id)).returning();
    await enqueueProcessMeeting({ meetingId: a.meeting.id, regenerate: true, templateId: body.templateId, effort: body.effort, model: body.draft ? config().ANTHROPIC_MODEL_DRAFT : undefined, instructions: body.instructions });
    const t = await templateById(m!.templateId);
    track(c.get("user").id, "report_regenerated", { first, template: t.code, withInstructions: !!body.instructions });
    return c.json(summaryDto(m!, t, { hasTranscript: true, hasReport: true, isOwner: true }), 202);
  },
);

meetingsRoutes.openapi(
  createRoute({
    method: "get",
    path: "/{id}/reports/{reportId}",
    tags: ["reports"],
    summary: "Конкретная версия отчёта",
    request: { params: IdParam.extend({ reportId: z.string().uuid() }) },
    responses: { 200: { description: "OK", content: { "application/json": { schema: ReportSchema } } } },
  }),
  async (c) => {
    const { id, reportId } = c.req.valid("param");
    const a = await loadMeetingWithAccess(id, c.get("user"));
    const [r] = await db().select().from(reports).where(and(eq(reports.id, reportId), eq(reports.meetingId, id))).limit(1);
    if (!r) throw new HTTPException(404, { message: "Отчёт не найден" });
    return c.json(reportDto(r, await templateById(r.templateId), a.scope === "full"), 200);
  },
);

meetingsRoutes.openapi(
  createRoute({
    method: "patch",
    path: "/{id}/reports/{reportId}",
    tags: ["reports"],
    summary: "Отредактировать текст отчёта (перед экспортом): заголовок, резюме, разделы, списки",
    request: { params: IdParam.extend({ reportId: z.string().uuid() }), body: { content: { "application/json": { schema: ReportEditBody } } } },
    responses: { 200: { description: "OK", content: { "application/json": { schema: ReportSchema } } }, 404: { description: "Не найдено", content: { "application/json": { schema: ErrorSchema } } } },
  }),
  async (c) => {
    const { id, reportId } = c.req.valid("param");
    const a = await loadMeetingWithAccess(id, c.get("user"));
    requireOwner(a);
    const body = c.req.valid("json");
    const [r0] = await db().select().from(reports).where(and(eq(reports.id, reportId), eq(reports.meetingId, id))).limit(1);
    if (!r0) throw new HTTPException(404, { message: "Отчёт не найден" });
    const t = await templateById(r0.templateId);
    const patch: Partial<Report> = {};
    if (body.title !== undefined) patch.title = body.title;
    if (body.summary !== undefined) patch.summary = body.summary;
    if (body.sections !== undefined) {
      const byKey = new Map(body.sections.map((s) => [s.key, s.content]));
      const existing = r0.sections.map((s) => (byKey.has(s.key) ? { ...s, content: byKey.get(s.key)! } : s));
      // Разделы шаблона, которых ещё не было в отчёте (модель их пропустила) — добавляем
      for (const [key, content] of byKey) {
        if (!existing.some((s) => s.key === key)) {
          const ts = t.reportSections.find((x) => x.key === key && x.kind === "text");
          if (ts) existing.push({ key, heading: ts.heading, content, internalOnly: ts.internalOnly ?? false });
        }
      }
      patch.sections = existing;
    }
    if (body.participants !== undefined) patch.participants = body.participants.map((p) => ({ name: p.name, role: p.role ?? null, company: p.company ?? null, side: p.side ?? null }));
    if (body.decisions !== undefined) patch.decisions = body.decisions;
    if (body.openQuestions !== undefined) patch.openQuestions = body.openQuestions;
    if (body.clientRequests !== undefined) patch.clientRequests = body.clientRequests;
    if (body.missingInfo !== undefined) patch.missingInfo = body.missingInfo;
    if (body.nextMeeting !== undefined) patch.nextMeeting = body.nextMeeting;
    patch.editedAt = new Date();
    patch.editedBy = c.get("user").id;
    const merged = { ...r0, ...patch } as Report;
    patch.markdown = renderMarkdown(t, merged, { startedAt: a.meeting.startedAt, durationSec: a.meeting.durationSec, platform: a.meeting.platform, templateTitle: t.title, confidentiality: a.meeting.confidentiality, includeInternal: true });
    const [r] = await db().update(reports).set(patch).where(eq(reports.id, reportId)).returning();
    if (body.title !== undefined) await db().update(meetings).set({ title: body.title }).where(eq(meetings.id, id));
    return c.json(reportDto(r!, t, true), 200);
  },
);

meetingsRoutes.openapi(
  createRoute({
    method: "patch",
    path: "/{id}/reports/{reportId}/action-items",
    tags: ["reports"],
    summary: "Обновить action items (отметить выполненные, поправить текст)",
    request: { params: IdParam.extend({ reportId: z.string().uuid() }), body: { content: { "application/json": { schema: ActionItemsBody } } } },
    responses: { 200: { description: "OK", content: { "application/json": { schema: ReportSchema } } } },
  }),
  async (c) => {
    const { id, reportId } = c.req.valid("param");
    const a = await loadMeetingWithAccess(id, c.get("user"));
    requireOwner(a);
    const { actionItems } = c.req.valid("json");
    const [r0] = await db().select().from(reports).where(and(eq(reports.id, reportId), eq(reports.meetingId, id))).limit(1);
    if (!r0) throw new HTTPException(404, { message: "Отчёт не найден" });
    const t = await templateById(r0.templateId);
    const updated = { ...r0, actionItems };
    const markdown = renderMarkdown(t, updated, { startedAt: a.meeting.startedAt, durationSec: a.meeting.durationSec, platform: a.meeting.platform, templateTitle: t.title, confidentiality: a.meeting.confidentiality, includeInternal: true });
    const [r] = await db().update(reports).set({ actionItems, markdown }).where(eq(reports.id, reportId)).returning();
    return c.json(reportDto(r!, t, true), 200);
  },
);

// ---------- Экспорт ----------
meetingsRoutes.openapi(
  createRoute({
    method: "get",
    path: "/{id}/export",
    tags: ["reports"],
    summary: "Экспорт текущего отчёта: md | docx | pdf | txt (транскрипт)",
    request: { params: IdParam, query: z.object({ format: z.enum(["md", "docx", "pdf", "txt"]).default("docx"), internal: z.enum(["0", "1"]).default("1") }) },
    responses: { 200: { description: "Файл" }, 404: { description: "Отчёта нет", content: { "application/json": { schema: ErrorSchema } } } },
  }),
  async (c) => {
    const a = await loadMeetingWithAccess(c.req.valid("param").id, c.get("user"));
    const { format, internal } = c.req.valid("query");
    const d = db();
    const m = a.meeting;
    const safeName = (m.title || "report").replace(/[^\p{L}\p{N} _-]+/gu, "").slice(0, 60).trim() || "report";
    const cd = (ext: string) => `attachment; filename*=UTF-8''${encodeURIComponent(safeName)}.${ext}`;

    if (format === "txt") {
      if (a.scope === "report") throw new HTTPException(403, { message: "Транскрипт недоступен по этой ссылке" });
      const [tr] = await d.select().from(transcripts).where(eq(transcripts.meetingId, m.id)).limit(1);
      if (!tr) throw new HTTPException(404, { message: "Транскрипта нет" });
      const { formatTranscript } = await import("../../llm/prompt.js");
      return c.body(formatTranscript(tr.segments, tr.speakers, tr.speakerRoles ?? {}), 200, { "Content-Type": "text/plain; charset=utf-8", "Content-Disposition": cd("txt") });
    }

    const [r] = await d.select().from(reports).where(and(eq(reports.meetingId, m.id), eq(reports.isCurrent, true))).limit(1);
    if (!r) throw new HTTPException(404, { message: "Отчёта ещё нет" });
    const t = await templateById(r.templateId);
    const includeInternal = a.scope === "full" && internal === "1";
    const meta = { startedAt: m.startedAt, durationSec: m.durationSec, platform: m.platform, templateTitle: t.title, confidentiality: m.confidentiality, includeInternal };
    if (format === "md") return c.body(renderMarkdown(t, r, meta), 200, { "Content-Type": "text/markdown; charset=utf-8", "Content-Disposition": cd("md") });
    if (format === "pdf") {
      const buf = await renderPdf(t, r, meta);
      return c.body(new Uint8Array(buf), 200, { "Content-Type": "application/pdf", "Content-Disposition": cd("pdf") });
    }
    const buf = await renderDocx(t, r, meta);
    return c.body(new Uint8Array(buf), 200, { "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "Content-Disposition": cd("docx") });
  },
);

// ---------- Шаринг ----------
meetingsRoutes.openapi(
  createRoute({
    method: "get",
    path: "/{id}/shares",
    tags: ["shares"],
    summary: "Кому расшарена встреча",
    request: { params: IdParam },
    responses: { 200: { description: "OK", content: { "application/json": { schema: z.array(ShareSchema) } } } },
  }),
  async (c) => {
    const a = await loadMeetingWithAccess(c.req.valid("param").id, c.get("user"));
    requireOwner(a);
    const rows = await db().select().from(shares).where(eq(shares.meetingId, a.meeting.id)).orderBy(desc(shares.createdAt));
    return c.json(rows.map((s) => ({ id: s.id, recipientEmail: s.recipientEmail, scope: s.scope, createdAt: s.createdAt.toISOString() })), 200);
  },
);

meetingsRoutes.openapi(
  createRoute({
    method: "post",
    path: "/{id}/shares",
    tags: ["shares"],
    summary: "Поделиться встречей с коллегой по email",
    request: { params: IdParam, body: { content: { "application/json": { schema: ShareBody } } } },
    responses: { 201: { description: "OK", content: { "application/json": { schema: ShareSchema } } } },
  }),
  async (c) => {
    const a = await loadMeetingWithAccess(c.req.valid("param").id, c.get("user"));
    requireOwner(a);
    const body = c.req.valid("json");
    const email = body.email.trim().toLowerCase();
    const [recipient] = await db().select({ id: userTable.id }).from(userTable).where(eq(userTable.email, email)).limit(1);
    const [s] = await db()
      .insert(shares)
      .values({ meetingId: a.meeting.id, recipientEmail: email, recipientUserId: recipient?.id ?? null, scope: body.scope, createdBy: c.get("user").id })
      .returning();
    track(c.get("user").id, "meeting_shared", { scope: body.scope, knownUser: !!recipient });
    return c.json({ id: s!.id, recipientEmail: s!.recipientEmail, scope: s!.scope, createdAt: s!.createdAt.toISOString() }, 201);
  },
);

meetingsRoutes.openapi(
  createRoute({
    method: "delete",
    path: "/{id}/shares/{shareId}",
    tags: ["shares"],
    summary: "Отозвать доступ",
    request: { params: IdParam.extend({ shareId: z.string().uuid() }) },
    responses: { 200: { description: "OK", content: { "application/json": { schema: z.object({ ok: z.boolean() }) } } } },
  }),
  async (c) => {
    const { id, shareId } = c.req.valid("param");
    const a = await loadMeetingWithAccess(id, c.get("user"));
    requireOwner(a);
    await db().delete(shares).where(and(eq(shares.id, shareId), eq(shares.meetingId, id)));
    return c.json({ ok: true }, 200);
  },
);
