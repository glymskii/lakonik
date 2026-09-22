import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { track } from "../../analytics/amplitude.js";
import { and, asc, desc, eq, gt, ilike, inArray, isNull, or, sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { db } from "../../db/client.js";
import { meetings, people, reports, shares, tasks } from "../../db/schema/index.js";
import { findOrCreatePerson, isPlaceholderAssignee, normalizeTask, syncReportActionItems, type Task } from "../../tasks/service.js";
import { loadMeetingWithAccess, requireOwner, accessibleMeetingsWhere } from "../authz.js";
import { withOrg } from "../middleware/org.js";
import { requireUser, type AppEnv } from "../middleware/auth.js";
import { ErrorSchema, IdParam, TaskCreateBody, TaskPatchBody, TaskSchema } from "../schemas.js";

export const tasksRoutes = new OpenAPIHono<AppEnv>();
tasksRoutes.use("*", requireUser);
tasksRoutes.use("*", withOrg);

type MeetingRow = typeof meetings.$inferSelect;

export function taskDto(t: Task, m: Pick<MeetingRow, "title" | "startedAt" | "ownerId">, emoji: string, userId: string) {
  return {
    id: t.id,
    meetingId: t.meetingId,
    meetingTitle: m.title,
    meetingEmoji: emoji,
    meetingStartedAt: m.startedAt.toISOString(),
    task: t.task,
    assigneeName: t.assigneeName,
    assigneePersonId: t.assigneePersonId,
    deadlineText: t.deadlineText,
    deadlineDate: t.deadlineDate,
    deadlineIsDefault: t.deadlineIsDefault,
    quote: t.quote,
    status: t.status,
    doneAt: t.doneAt ? t.doneAt.toISOString() : null,
    source: t.source,
    isOwner: m.ownerId === userId,
    createdAt: t.createdAt.toISOString(),
  };
}

const emojiSql = sql<string>`(select emoji from meeting_templates mt where mt.id = "meetings"."template_id")`;

tasksRoutes.openapi(
  createRoute({
    method: "get",
    path: "/",
    tags: ["tasks"],
    summary: "Все задачи по доступным встречам",
    request: {
      query: z.object({
        status: z.enum(["open", "done", "all"]).default("open"),
        assignee: z.string().uuid().optional(),
        meetingId: z.string().uuid().optional(),
        q: z.string().max(100).optional(),
        limit: z.coerce.number().int().min(1).max(500).default(200),
      }),
    },
    responses: { 200: { description: "OK", content: { "application/json": { schema: z.object({ items: z.array(TaskSchema), openCount: z.number().int(), overdueCount: z.number().int() }) } } } },
  }),
  async (c) => {
    const u = c.get("user");
    const q = c.req.valid("query");
    const d = db();
    const where = and(
      eq(tasks.isCurrent, true),
      q.status === "all" ? undefined : eq(tasks.status, q.status),
      q.assignee ? eq(tasks.assigneePersonId, q.assignee) : undefined,
      q.meetingId ? eq(tasks.meetingId, q.meetingId) : undefined,
      q.q ? ilike(tasks.task, `%${q.q}%`) : undefined,
      accessibleMeetingsWhere(u, c.get("org")),
    );
    const rows = await d
      .select({ t: tasks, m: { title: meetings.title, startedAt: meetings.startedAt, ownerId: meetings.ownerId }, emoji: emojiSql })
      .from(tasks)
      .innerJoin(meetings, eq(meetings.id, tasks.meetingId))
      .where(where)
      .orderBy(sql`${tasks.deadlineDate} asc nulls last`, desc(meetings.startedAt), asc(tasks.position))
      .limit(q.limit);
    const today = new Date(Date.now() + 5 * 3600 * 1000).toISOString().slice(0, 10);
    const counts = await d
      .select({
        open: sql<number>`count(*) filter (where ${tasks.status} = 'open')::int`,
        overdue: sql<number>`count(*) filter (where ${tasks.status} = 'open' and ${tasks.deadlineDate} < ${today})::int`,
      })
      .from(tasks)
      .innerJoin(meetings, eq(meetings.id, tasks.meetingId))
      .where(and(eq(tasks.isCurrent, true), accessibleMeetingsWhere(u, c.get("org"))));
    return c.json({ items: rows.map((r) => taskDto(r.t, r.m, r.emoji ?? "📝", u.id)), openCount: counts[0]?.open ?? 0, overdueCount: counts[0]?.overdue ?? 0 }, 200);
  },
);

async function loadTask(id: string, userId: string) {
  const [row] = await db()
    .select({ t: tasks, m: meetings, emoji: emojiSql })
    .from(tasks)
    .innerJoin(meetings, eq(meetings.id, tasks.meetingId))
    .where(eq(tasks.id, id))
    .limit(1);
  if (!row) throw new HTTPException(404, { message: "Задача не найдена" });
  return row;
}

tasksRoutes.openapi(
  createRoute({
    method: "patch",
    path: "/{id}",
    tags: ["tasks"],
    summary: "Изменить задачу: статус, текст, ответственного, срок",
    request: { params: IdParam, body: { content: { "application/json": { schema: TaskPatchBody } } } },
    responses: { 200: { description: "OK", content: { "application/json": { schema: TaskSchema } } }, 404: { description: "Не найдено", content: { "application/json": { schema: ErrorSchema } } } },
  }),
  async (c) => {
    const u = c.get("user");
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const row = await loadTask(id, u.id);
    const access = await loadMeetingWithAccess(row.m.id, u); // проверка доступа (владелец, share, админ)
    if (access.scope !== "full" && body.status === undefined) requireOwner(access);

    const patch: Partial<Task> = {};
    if (body.task !== undefined) {
      patch.task = body.task;
      patch.normalizedTask = normalizeTask(body.task);
    }
    if (body.status !== undefined) {
      patch.status = body.status;
      patch.doneAt = body.status === "done" ? new Date() : null;
      if (body.status === "done") track(u.id, "task_done", { isOwner: access.scope === "full" });
    }
    if (body.assigneePersonId !== undefined || body.assigneeName !== undefined) {
      if (body.assigneePersonId) {
        const [p] = await db().select().from(people).where(eq(people.id, body.assigneePersonId)).limit(1);
        if (!p) throw new HTTPException(404, { message: "Человек не найден в справочнике" });
        patch.assigneePersonId = p.id;
        patch.assigneeName = p.name;
      } else if (body.assigneeName && !isPlaceholderAssignee(body.assigneeName)) {
        const p = await findOrCreatePerson(body.assigneeName, { source: "manual", createdBy: u.id, agencyId: u.agencyId, organizationId: row.m.organizationId });
        patch.assigneePersonId = p.id;
        patch.assigneeName = p.name;
      } else {
        patch.assigneePersonId = null;
        patch.assigneeName = body.assigneeName ?? null;
      }
    }
    if (body.deadlineDate !== undefined) {
      patch.deadlineDate = body.deadlineDate;
      patch.deadlineIsDefault = false;
      patch.remindedAt = null;
    }
    if (body.deadlineText !== undefined) patch.deadlineText = body.deadlineText;

    const [updated] = await db().update(tasks).set(patch).where(eq(tasks.id, id)).returning();
    await syncReportActionItems(row.m.id);
    return c.json(taskDto(updated!, row.m, row.emoji ?? "📝", u.id), 200);
  },
);

tasksRoutes.openapi(
  createRoute({
    method: "delete",
    path: "/{id}",
    tags: ["tasks"],
    summary: "Удалить задачу",
    request: { params: IdParam },
    responses: { 200: { description: "OK", content: { "application/json": { schema: z.object({ ok: z.boolean() }) } } } },
  }),
  async (c) => {
    const u = c.get("user");
    const { id } = c.req.valid("param");
    const row = await loadTask(id, u.id);
    requireOwner(await loadMeetingWithAccess(row.m.id, u));
    await db().delete(tasks).where(eq(tasks.id, id));
    await syncReportActionItems(row.m.id);
    return c.json({ ok: true }, 200);
  },
);

/** Ручная задача к встрече: POST /api/meetings/:id/tasks (маршрут монтируется в meetings) */
export const meetingTasksRoutes = new OpenAPIHono<AppEnv>();
meetingTasksRoutes.use("*", requireUser);

meetingTasksRoutes.openapi(
  createRoute({
    method: "get",
    path: "/{id}/tasks",
    tags: ["tasks"],
    summary: "Задачи встречи (текущие)",
    request: { params: IdParam },
    responses: { 200: { description: "OK", content: { "application/json": { schema: z.array(TaskSchema) } } } },
  }),
  async (c) => {
    const u = c.get("user");
    const a = await loadMeetingWithAccess(c.req.valid("param").id, u);
    const rows = await db()
      .select({ t: tasks, emoji: emojiSql })
      .from(tasks)
      .innerJoin(meetings, eq(meetings.id, tasks.meetingId))
      .where(and(eq(tasks.meetingId, a.meeting.id), eq(tasks.isCurrent, true)))
      .orderBy(asc(tasks.position), asc(tasks.createdAt));
    return c.json(rows.map((r) => taskDto(r.t, a.meeting, r.emoji ?? "📝", u.id)), 200);
  },
);

meetingTasksRoutes.openapi(
  createRoute({
    method: "post",
    path: "/{id}/tasks",
    tags: ["tasks"],
    summary: "Добавить задачу к встрече вручную",
    request: { params: IdParam, body: { content: { "application/json": { schema: TaskCreateBody } } } },
    responses: { 201: { description: "OK", content: { "application/json": { schema: TaskSchema } } } },
  }),
  async (c) => {
    const u = c.get("user");
    const a = await loadMeetingWithAccess(c.req.valid("param").id, u);
    requireOwner(a);
    const body = c.req.valid("json");
    let personId: string | null = null;
    let assigneeName: string | null = body.assigneeName ?? null;
    if (body.assigneePersonId) {
      const [p] = await db().select().from(people).where(eq(people.id, body.assigneePersonId)).limit(1);
      if (!p) throw new HTTPException(404, { message: "Человек не найден в справочнике" });
      personId = p.id;
      assigneeName = p.name;
    } else if (body.assigneeName && !isPlaceholderAssignee(body.assigneeName)) {
      const p = await findOrCreatePerson(body.assigneeName, { source: "manual", createdBy: u.id, agencyId: u.agencyId, organizationId: a.meeting.organizationId });
      personId = p.id;
      assigneeName = p.name;
    }
    const [r] = await db().select({ id: reports.id }).from(reports).where(and(eq(reports.meetingId, a.meeting.id), eq(reports.isCurrent, true))).limit(1);
    const [maxPos] = await db().select({ p: sql<number>`coalesce(max(${tasks.position}), -1)::int` }).from(tasks).where(and(eq(tasks.meetingId, a.meeting.id), eq(tasks.isCurrent, true)));
    const [t] = await db()
      .insert(tasks)
      .values({
        meetingId: a.meeting.id,
        reportId: r?.id ?? null,
        ownerId: a.meeting.ownerId,
        agencyId: a.meeting.agencyId,
        organizationId: a.meeting.organizationId,
        position: (maxPos?.p ?? -1) + 1,
        task: body.task,
        normalizedTask: normalizeTask(body.task),
        assigneeName,
        assigneePersonId: personId,
        deadlineDate: body.deadlineDate ?? null,
        deadlineIsDefault: false,
        source: "manual",
        isCurrent: true,
      })
      .returning();
    await syncReportActionItems(a.meeting.id);
    const [em] = await db().select({ emoji: emojiSql }).from(meetings).where(eq(meetings.id, a.meeting.id)).limit(1);
    return c.json(taskDto(t!, a.meeting, em?.emoji ?? "📝", u.id), 201);
  },
);
