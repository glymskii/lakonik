import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import { db } from "../db/client.js";
import { meetingTemplates, meetings, organizations, people, reports, settings, tasks } from "../db/schema/index.js";
import { DEFAULT_DEADLINE_SETTINGS, type ActionItem, type DeadlineSettings } from "../db/types.js";
import { renderMarkdown } from "../export/markdown.js";
import { logger } from "../logger.js";

type Meeting = typeof meetings.$inferSelect;
type Report = typeof reports.$inferSelect;
export type Task = typeof tasks.$inferSelect;
export type Person = typeof people.$inferSelect;

// ---------- Нормализация ----------

export function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ");
}

export function normalizeTask(text: string): string {
  return text.trim().toLowerCase().replace(/ё/g, "е").replace(/[^\p{L}\p{N}\s]/gu, "").replace(/\s+/g, " ").slice(0, 200);
}

const PLACEHOLDER = /^(спикер\s*\d+|speaker[_\s]*\d+|—|-|не назван.*|не озвучен.*|неизвестн.*|tbd|n\/a|null)$/i;

/** «Спикер 2», «не назван», «—» — не люди, в справочник не попадают. */
export function isPlaceholderAssignee(name: string | null | undefined): boolean {
  if (!name) return true;
  const n = name.trim();
  return n.length < 2 || PLACEHOLDER.test(n);
}

// ---------- Настройки ----------

/** Сроки: настройки организации (organizations.settings.deadlines); без организации — старая глобальная строка */
export async function getDeadlineSettings(organizationId?: string | null): Promise<Required<DeadlineSettings>> {
  if (organizationId) {
    const [o] = await db().select({ settings: organizations.settings }).from(organizations).where(eq(organizations.id, organizationId)).limit(1);
    return { ...DEFAULT_DEADLINE_SETTINGS, ...(o?.settings.deadlines ?? {}) };
  }
  const [row] = await db().select().from(settings).where(eq(settings.id, "global")).limit(1);
  return { ...DEFAULT_DEADLINE_SETTINGS, ...(row?.deadlines ?? {}) };
}

export async function saveDeadlineSettings(patch: DeadlineSettings, updatedBy: string, organizationId?: string | null): Promise<Required<DeadlineSettings>> {
  const current = await getDeadlineSettings(organizationId);
  const merged: DeadlineSettings = { ...current, ...patch };
  if (organizationId) {
    const [o] = await db().select({ settings: organizations.settings }).from(organizations).where(eq(organizations.id, organizationId)).limit(1);
    await db().update(organizations).set({ settings: { ...(o?.settings ?? {}), deadlines: merged } }).where(eq(organizations.id, organizationId));
    return { ...DEFAULT_DEADLINE_SETTINGS, ...merged };
  }
  await db()
    .insert(settings)
    .values({ id: "global", deadlines: merged, updatedBy })
    .onConflictDoUpdate({ target: settings.id, set: { deadlines: merged, updatedBy } });
  return { ...DEFAULT_DEADLINE_SETTINGS, ...merged };
}

/** Дата по умолчанию: meetingDate + N дней (по рабочим дням, если включено). Возвращает YYYY-MM-DD в часовом поясе Алматы. */
export function computeDefaultDeadline(meetingDate: Date, s: Required<DeadlineSettings>): string | null {
  if (!s.defaultTaskDeadlineDays || s.defaultTaskDeadlineDays <= 0) return null;
  const d = new Date(meetingDate);
  let remaining = s.defaultTaskDeadlineDays;
  while (remaining > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    const dow = almatyDow(d);
    if (!s.workingDaysOnly || (dow !== 0 && dow !== 6)) remaining--;
  }
  return toAlmatyDate(d);
}

const ALMATY_OFFSET_MIN = 5 * 60; // UTC+5

export function toAlmatyDate(d: Date): string {
  const local = new Date(d.getTime() + ALMATY_OFFSET_MIN * 60_000);
  return local.toISOString().slice(0, 10);
}

function almatyDow(d: Date): number {
  return new Date(d.getTime() + ALMATY_OFFSET_MIN * 60_000).getUTCDay();
}

export function todayAlmaty(): string {
  return toAlmatyDate(new Date());
}

// ---------- Люди ----------

/** Справочник людей живёт внутри организации: имя уникально в пределах organizationId */
export async function findOrCreatePerson(name: string, opts: { source: "manual" | "ai"; createdBy: string | null; agencyId: string | null; organizationId: string | null; role?: string | null; company?: string | null; email?: string | null }): Promise<Person> {
  const d = db();
  const normalized = normalizeName(name);
  const orgWhere = opts.organizationId ? eq(people.organizationId, opts.organizationId) : isNull(people.organizationId);
  const [existing] = await d.select().from(people).where(and(eq(people.normalizedName, normalized), orgWhere)).limit(1);
  if (existing) {
    if (!existing.isActive) await d.update(people).set({ isActive: true }).where(eq(people.id, existing.id));
    return existing;
  }
  const [created] = await d
    .insert(people)
    .values({ name: name.trim(), normalizedName: normalized, role: opts.role ?? null, company: opts.company ?? null, email: opts.email?.toLowerCase() ?? null, agencyId: opts.agencyId, organizationId: opts.organizationId, source: opts.source, createdBy: opts.createdBy })
    .onConflictDoNothing()
    .returning();
  if (created) return created;
  const [again] = await d.select().from(people).where(and(eq(people.normalizedName, normalized), orgWhere)).limit(1);
  return again!;
}

// ---------- Задачи ----------

function isValidIsoDate(s: string | null | undefined): s is string {
  return !!s && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
}

/**
 * Создаёт задачи из action items отчёта. Предыдущие текущие задачи встречи помечаются isCurrent=false,
 * статус done и ручные правки переносятся по совпадению текста; ручные задачи (source=manual) сохраняются.
 */
export async function syncTasksFromReport(meeting: Meeting, report: Report, items: ActionItem[]): Promise<Task[]> {
  const d = db();
  const s = await getDeadlineSettings(meeting.organizationId);
  const defaultDeadline = computeDefaultDeadline(meeting.startedAt, s);

  const previous = await d.select().from(tasks).where(and(eq(tasks.meetingId, meeting.id), eq(tasks.isCurrent, true)));
  const prevByText = new Map(previous.map((t) => [t.normalizedTask, t]));

  const created: Task[] = [];
  await d.transaction(async (tx) => {
    // AI-задачи предыдущей версии уходят в историю; ручные остаются текущими
    const aiPrevIds = previous.filter((t) => t.source === "ai").map((t) => t.id);
    if (aiPrevIds.length) await tx.update(tasks).set({ isCurrent: false }).where(inArray(tasks.id, aiPrevIds));

    let pos = 0;
    for (const item of items) {
      const text = item.task?.trim();
      if (!text) continue;
      const normalized = normalizeTask(text);
      const prev = prevByText.get(normalized);
      let personId: string | null = prev?.assigneePersonId ?? null;
      let assigneeName: string | null = prev?.assigneeName ?? item.assignee ?? null;
      if (!personId && !isPlaceholderAssignee(item.assignee)) {
        const person = await findOrCreatePerson(item.assignee!, { source: "ai", createdBy: meeting.ownerId, agencyId: meeting.agencyId, organizationId: meeting.organizationId });
        personId = person.id;
        assigneeName = person.name;
      }
      const hasDate = isValidIsoDate(item.deadlineDate);
      const deadlineDate = prev?.deadlineDate ?? (hasDate ? item.deadlineDate! : defaultDeadline);
      const deadlineIsDefault = prev ? prev.deadlineIsDefault : !hasDate && !!defaultDeadline;
      const [row] = await tx
        .insert(tasks)
        .values({
          meetingId: meeting.id,
          reportId: report.id,
          ownerId: meeting.ownerId,
          agencyId: meeting.agencyId,
          organizationId: meeting.organizationId,
          position: pos++,
          task: text,
          normalizedTask: normalized,
          assigneeName,
          assigneePersonId: personId,
          deadlineText: item.deadline ?? null,
          deadlineDate,
          deadlineIsDefault,
          quote: item.quote ?? null,
          status: prev?.status ?? "open",
          doneAt: prev?.doneAt ?? null,
          source: "ai",
          isCurrent: true,
        })
        .returning();
      created.push(row!);
    }
  });
  logger.info({ meetingId: meeting.id, tasks: created.length, carried: previous.length }, "Задачи синхронизированы");
  return created;
}

export async function currentTasks(meetingId: string): Promise<Task[]> {
  return db().select().from(tasks).where(and(eq(tasks.meetingId, meetingId), eq(tasks.isCurrent, true))).orderBy(asc(tasks.position), asc(tasks.createdAt));
}

/** Пересобирает reports.action_items и markdown текущего отчёта из живых задач (для экспорта). */
export async function syncReportActionItems(meetingId: string): Promise<void> {
  const d = db();
  const [m] = await d.select().from(meetings).where(eq(meetings.id, meetingId)).limit(1);
  const [r] = await d.select().from(reports).where(and(eq(reports.meetingId, meetingId), eq(reports.isCurrent, true))).limit(1);
  if (!m || !r) return;
  const [t] = await d.select().from(meetingTemplates).where(eq(meetingTemplates.id, r.templateId)).limit(1);
  if (!t) return;
  const list = await currentTasks(meetingId);
  const actionItems: ActionItem[] = list.map((x) => ({
    assignee: x.assigneeName,
    task: x.task,
    deadline: x.deadlineDate ? formatRuDate(x.deadlineDate) + (x.deadlineIsDefault ? " (по умолчанию)" : "") : x.deadlineText,
    deadlineDate: x.deadlineDate,
    quote: x.quote,
    done: x.status === "done",
  }));
  const updated = { ...r, actionItems };
  const markdown = renderMarkdown(t, updated, { startedAt: m.startedAt, durationSec: m.durationSec, platform: m.platform, templateTitle: t.title, confidentiality: m.confidentiality, includeInternal: true });
  await d.update(reports).set({ actionItems, markdown }).where(eq(reports.id, r.id));
}

export function formatRuDate(iso: string): string {
  const [y, mo, da] = iso.split("-").map(Number);
  const months = ["янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
  return `${da} ${months[(mo ?? 1) - 1]} ${y}`;
}

/** Задачи, по которым пора напомнить: дедлайн = сегодня + remindDaysBefore, ещё не напоминали, открыты. */
export async function tasksDueForReminder(): Promise<Task[]> {
  const s = await getDeadlineSettings();
  if (!s.remindDaysBefore || s.remindDaysBefore < 0) return [];
  const target = new Date();
  target.setUTCDate(target.getUTCDate() + s.remindDaysBefore);
  const date = toAlmatyDate(target);
  return db()
    .select()
    .from(tasks)
    .where(and(eq(tasks.isCurrent, true), eq(tasks.status, "open"), eq(tasks.deadlineDate, date)))
    .orderBy(desc(tasks.createdAt));
}
