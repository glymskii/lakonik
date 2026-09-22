import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { user } from "./auth.js";
import { organizations } from "./org.js";
import type {
  ActionItem,
  ContextFields,
  DeadlineSettings,
  DecisionItem,
  Marker,
  NextMeeting,
  Participant,
  ReportSection,
  SpeakerMap,
  SpeakerRoleMap,
  SpeakerSuggestions,
  TemplateField,
  TemplateSection,
  TranscriptSegment,
} from "../types.js";

export const meetingStatus = pgEnum("meeting_status", [
  "recording",
  "uploading",
  "queued",
  "processing",
  "transcribing",
  /** расшифровка готова, ждём подтверждения спикеров и выбора типа встречи (отчёт ещё не строился) */
  "transcribed",
  "summarizing",
  "done",
  "failed",
]);

export const confidentiality = pgEnum("confidentiality", ["standard", "restricted"]);
export const meetingSource = pgEnum("meeting_source", ["recorded", "imported"]);
export const audioKind = pgEnum("audio_kind", ["segment", "merged", "import"]);
export const shareScope = pgEnum("share_scope", ["report", "report_transcript"]);

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull(),
};

/** Агентства холдинга (ADV, Havas, UM, McCann, SEED, Pixy, Mushrooms, Bid Media). */
export const agencies = pgTable("agencies", {
  id: text("id").primaryKey(), // slug: adv, havas, um, ...
  name: text("name").notNull(),
  emailDomains: text("email_domains").array().notNull().default(sql`'{}'::text[]`),
  keyterms: text("keyterms").array().notNull().default(sql`'{}'::text[]`), // словарь для STT
  isActive: boolean("is_active").default(true).notNull(),
  ...timestamps,
});

/** Шаблоны контакт-репортов (сид из packages/shared/templates.json, дальше правятся в админке). */
export const meetingTemplates = pgTable(
  "meeting_templates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** null — встроенный шаблон; иначе приватный шаблон организации */
    organizationId: uuid("organization_id").references(() => organizations.id, { onDelete: "cascade" }),
    code: text("code").notNull(),
    version: integer("version").notNull().default(1),
    group: text("group").notNull(), // internal | client | vendor
    category: text("category").notNull(), // sales | production | operations | management | hr
    title: text("title").notNull(),
    subtitle: text("subtitle"),
    goal: text("goal").notNull(),
    reportTitle: text("report_title").notNull(),
    emoji: text("emoji").notNull(),
    color: text("color").notNull(),
    confidentiality: confidentiality("confidentiality").notNull().default("standard"),
    allowConfidentialityChoice: boolean("allow_confidentiality_choice").notNull().default(false),
    slaHours: integer("sla_hours").notNull().default(24),
    sendTo: text("send_to"),
    tone: text("tone"),
    commonFields: jsonb("common_fields").$type<TemplateField[]>().notNull().default([]),
    specificFields: jsonb("specific_fields").$type<TemplateField[]>().notNull().default([]),
    reportSections: jsonb("report_sections").$type<TemplateSection[]>().notNull().default([]),
    rules: text("rules").array().notNull().default(sql`'{}'::text[]`),
    tips: text("tips").array().notNull().default(sql`'{}'::text[]`),
    sortOrder: integer("sort_order").notNull().default(0),
    isActive: boolean("is_active").notNull().default(true),
    isDraft: boolean("is_draft").notNull().default(false),
    ...timestamps,
  },
  (t) => [
    // NULLS NOT DISTINCT: у встроенных шаблонов (organization_id = null) код+версия тоже уникальны
    unique("meeting_templates_org_code_version_uq").on(t.organizationId, t.code, t.version).nullsNotDistinct(),
    index("meeting_templates_org_idx").on(t.organizationId),
  ],
);

export const meetings = pgTable(
  "meetings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    agencyId: text("agency_id").references(() => agencies.id),
    /** Пространство, которому принадлежит встреча (null только до переноса данных) */
    organizationId: uuid("organization_id").references(() => organizations.id, { onDelete: "cascade" }),
    /** Прежний владелец, если встреча передана при удалении участника или его аккаунта */
    orphanedFrom: text("orphaned_from").references(() => user.id, { onDelete: "set null" }),
    templateId: uuid("template_id")
      .notNull()
      .references(() => meetingTemplates.id),
    templateCode: text("template_code").notNull(),
    templateVersion: integer("template_version").notNull(),
    title: text("title").notNull(),
    status: meetingStatus("status").notNull().default("recording"),
    statusDetail: text("status_detail"),
    error: text("error"),
    source: meetingSource("source").notNull().default("recorded"),
    confidentiality: confidentiality("confidentiality").notNull().default("standard"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    durationSec: integer("duration_sec"),
    contextFields: jsonb("context_fields").$type<ContextFields>().notNull().default({}),
    participantsHint: jsonb("participants_hint").$type<Participant[]>().notNull().default([]),
    numSpeakersHint: integer("num_speakers_hint"),
    languageHint: text("language_hint"), // ru | kk | en | null (auto)
    platform: text("platform"),
    markers: jsonb("markers").$type<Marker[]>().notNull().default([]),
    segmentCount: integer("segment_count").notNull().default(0),
    deviceId: text("device_id"),
    ...timestamps,
  },
  (t) => [
    index("meetings_owner_idx").on(t.ownerId, t.createdAt),
    index("meetings_agency_idx").on(t.agencyId, t.createdAt),
    index("meetings_org_idx").on(t.organizationId, t.createdAt),
    index("meetings_status_idx").on(t.status),
  ],
);

/** Временные аудио-объекты в bucket. Удаляются после транскрибации; cron дочищает старше N часов. */
export const audioObjects = pgTable(
  "audio_objects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    meetingId: uuid("meeting_id")
      .notNull()
      .references(() => meetings.id, { onDelete: "cascade" }),
    kind: audioKind("kind").notNull(),
    seq: integer("seq").notNull().default(0),
    objectKey: text("object_key").notNull(),
    contentType: text("content_type").notNull().default("audio/mp4"),
    sizeBytes: integer("size_bytes"),
    durationSec: numeric("duration_sec", { precision: 10, scale: 3 }),
    uploadedAt: timestamp("uploaded_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("audio_objects_meeting_kind_seq_idx").on(t.meetingId, t.kind, t.seq),
    index("audio_objects_pending_idx").on(t.deletedAt, t.createdAt),
  ],
);

export const transcripts = pgTable(
  "transcripts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    meetingId: uuid("meeting_id")
      .notNull()
      .references(() => meetings.id, { onDelete: "cascade" })
      .unique(),
    provider: text("provider").notNull(),
    providerRequestId: text("provider_request_id"),
    languageCode: text("language_code"),
    languageProbability: numeric("language_probability", { precision: 5, scale: 4 }),
    fullText: text("full_text").notNull(),
    segments: jsonb("segments").$type<TranscriptSegment[]>().notNull().default([]),
    speakers: jsonb("speakers").$type<SpeakerMap>().notNull().default({}),
    /** speaker_N, который является владельцем записи (пользователем приложения) */
    selfSpeakerId: text("self_speaker_id"),
    /** роли спикеров: ours / client / vendor — для нумерации «Клиент 1, Клиент 2» и для отчёта */
    speakerRoles: jsonb("speaker_roles").$type<SpeakerRoleMap>().notNull().default({}),
    /** предположения LLM после расшифровки: кто есть кто, дубли диаризации — пользователь подтверждает */
    speakerSuggestions: jsonb("speaker_suggestions").$type<SpeakerSuggestions | null>(),
    /** когда владелец подтвердил спикеров после расшифровки (имена, роли, слияния) */
    speakersConfirmedAt: timestamp("speakers_confirmed_at", { withTimezone: true }),
    audioDurationSec: numeric("audio_duration_sec", { precision: 10, scale: 3 }),
    wordCount: integer("word_count").notNull().default(0),
    costUsd: numeric("cost_usd", { precision: 10, scale: 4 }),
    ...timestamps,
  },
);

export const reports = pgTable(
  "reports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    meetingId: uuid("meeting_id")
      .notNull()
      .references(() => meetings.id, { onDelete: "cascade" }),
    version: integer("version").notNull().default(1),
    templateId: uuid("template_id")
      .notNull()
      .references(() => meetingTemplates.id),
    templateCode: text("template_code").notNull(),
    templateVersion: integer("template_version").notNull(),
    model: text("model").notNull(),
    effort: text("effort"),
    title: text("title").notNull(),
    summary: text("summary").notNull(),
    participants: jsonb("participants").$type<Participant[]>().notNull().default([]),
    sections: jsonb("sections").$type<ReportSection[]>().notNull().default([]),
    actionItems: jsonb("action_items").$type<ActionItem[]>().notNull().default([]),
    decisions: jsonb("decisions").$type<DecisionItem[]>().notNull().default([]),
    openQuestions: text("open_questions").array().notNull().default(sql`'{}'::text[]`),
    clientRequests: text("client_requests").array().notNull().default(sql`'{}'::text[]`),
    missingInfo: text("missing_info").array().notNull().default(sql`'{}'::text[]`),
    nextMeeting: jsonb("next_meeting").$type<NextMeeting | null>(),
    markdown: text("markdown").notNull(),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    cacheReadTokens: integer("cache_read_tokens"),
    costUsd: numeric("cost_usd", { precision: 10, scale: 4 }),
    createdBy: text("created_by").notNull().default("pipeline"), // pipeline | regenerate
    isCurrent: boolean("is_current").notNull().default(true),
    /** Ручные правки текста отчёта пользователем (перед экспортом) */
    editedAt: timestamp("edited_at", { withTimezone: true }),
    editedBy: text("edited_by"),
    /** Инструкции пользователя для ИИ-пересборки (что исправить) */
    instructions: text("instructions"),
    ...timestamps,
  },
  (t) => [uniqueIndex("reports_meeting_version_idx").on(t.meetingId, t.version)],
);

export const shares = pgTable(
  "shares",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    meetingId: uuid("meeting_id")
      .notNull()
      .references(() => meetings.id, { onDelete: "cascade" }),
    recipientEmail: text("recipient_email").notNull(),
    recipientUserId: text("recipient_user_id").references(() => user.id, { onDelete: "set null" }),
    scope: shareScope("scope").notNull().default("report"),
    createdBy: text("created_by")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [index("shares_recipient_idx").on(t.recipientEmail), index("shares_meeting_idx").on(t.meetingId)],
);

export const devices = pgTable(
  "devices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    platform: text("platform").notNull(), // ios | android
    pushToken: text("push_token").notNull(),
    appVersion: text("app_version"),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).defaultNow().notNull(),
    ...timestamps,
  },
  (t) => [uniqueIndex("devices_token_idx").on(t.pushToken), index("devices_user_idx").on(t.userId)],
);

export const usageEvents = pgTable(
  "usage_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    meetingId: uuid("meeting_id").references(() => meetings.id, { onDelete: "set null" }),
    userId: text("user_id").references(() => user.id, { onDelete: "set null" }),
    agencyId: text("agency_id"),
    organizationId: uuid("organization_id").references(() => organizations.id, { onDelete: "set null" }),
    kind: text("kind").notNull(), // stt | llm | export
    provider: text("provider").notNull(),
    model: text("model"),
    amount: numeric("amount", { precision: 14, scale: 3 }).notNull(), // секунды аудио / токены
    unit: text("unit").notNull(), // seconds | tokens
    costUsd: numeric("cost_usd", { precision: 10, scale: 4 }).notNull().default("0"),
    meta: jsonb("meta").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("usage_events_agency_idx").on(t.agencyId, t.createdAt), index("usage_events_org_idx").on(t.organizationId, t.createdAt)],
);

/** Справочник ответственных (общий для холдинга): добавляется вручную или из action items отчётов. */
export const people = pgTable(
  "people",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    normalizedName: text("normalized_name").notNull(),
    role: text("role"),
    company: text("company"),
    email: text("email"),
    agencyId: text("agency_id").references(() => agencies.id),
    organizationId: uuid("organization_id").references(() => organizations.id, { onDelete: "cascade" }),
    source: text("source").notNull().default("manual"), // manual | ai
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    isActive: boolean("is_active").notNull().default(true),
    ...timestamps,
  },
  (t) => [
    // Имя уникально внутри организации (раньше — глобально)
    uniqueIndex("people_org_normalized_name_idx").on(t.organizationId, t.normalizedName),
    index("people_active_idx").on(t.isActive),
  ],
);

export const taskStatus = pgEnum("task_status", ["open", "done"]);

/** Задачи (action items) по всем встречам — живое состояние; reports.action_items хранит извлечение модели. */
export const tasks = pgTable(
  "tasks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    meetingId: uuid("meeting_id")
      .notNull()
      .references(() => meetings.id, { onDelete: "cascade" }),
    reportId: uuid("report_id").references(() => reports.id, { onDelete: "set null" }),
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    agencyId: text("agency_id"),
    organizationId: uuid("organization_id").references(() => organizations.id, { onDelete: "cascade" }),
    position: integer("position").notNull().default(0),
    task: text("task").notNull(),
    normalizedTask: text("normalized_task").notNull(),
    assigneeName: text("assignee_name"),
    assigneePersonId: uuid("assignee_person_id").references(() => people.id, { onDelete: "set null" }),
    deadlineText: text("deadline_text"),
    deadlineDate: text("deadline_date"), // YYYY-MM-DD
    deadlineIsDefault: boolean("deadline_is_default").notNull().default(false),
    quote: text("quote"),
    status: taskStatus("status").notNull().default("open"),
    doneAt: timestamp("done_at", { withTimezone: true }),
    source: text("source").notNull().default("ai"), // ai | manual
    isCurrent: boolean("is_current").notNull().default(true),
    remindedAt: timestamp("reminded_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index("tasks_owner_status_idx").on(t.ownerId, t.status, t.deadlineDate),
    index("tasks_org_idx").on(t.organizationId, t.status),
    index("tasks_meeting_idx").on(t.meetingId),
    index("tasks_assignee_idx").on(t.assigneePersonId),
  ],
);

/** Настройки холдинга (одна строка id='global'): сроки по умолчанию, SLA отчётов, напоминания. */
export const settings = pgTable("settings", {
  id: text("id").primaryKey(), // 'global'
  deadlines: jsonb("deadlines").$type<DeadlineSettings>().notNull().default({}),
  updatedBy: text("updated_by"),
  ...timestamps,
});
