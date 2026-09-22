import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { and, asc, eq, ilike, isNull, or, sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { db } from "../../db/client.js";
import { people, tasks } from "../../db/schema/index.js";
import { findOrCreatePerson, normalizeName } from "../../tasks/service.js";
import { requireUser, type AppEnv } from "../middleware/auth.js";
import { withOrg } from "../middleware/org.js";
import { ErrorSchema, IdParam, PersonBody, PersonSchema } from "../schemas.js";

export const peopleRoutes = new OpenAPIHono<AppEnv>();
peopleRoutes.use("*", requireUser);
peopleRoutes.use("*", withOrg);

// Внимание: ${people.id} в select рендерится как "id" без имени таблицы и внутри подзапроса ссылался бы на t.id
const openTasksSql = sql<number>`(select count(*) from ${tasks} t where t.assignee_person_id = "people"."id" and t.is_current and t.status = 'open')::int`;

function dto(p: typeof people.$inferSelect, openTasks?: number) {
  return { id: p.id, name: p.name, role: p.role, company: p.company, email: p.email, agencyId: p.agencyId, source: p.source, isActive: p.isActive, openTasks };
}

peopleRoutes.openapi(
  createRoute({
    method: "get",
    path: "/",
    tags: ["people"],
    summary: "Справочник ответственных текущего пространства",
    request: { query: z.object({ q: z.string().max(80).optional(), includeInactive: z.enum(["0", "1"]).default("0") }) },
    responses: { 200: { description: "OK", content: { "application/json": { schema: z.array(PersonSchema) } } } },
  }),
  async (c) => {
    const { q, includeInactive } = c.req.valid("query");
    const org = c.get("org");
    const rows = await db()
      .select({ p: people, openTasks: openTasksSql })
      .from(people)
      .where(and(org ? eq(people.organizationId, org.id) : isNull(people.organizationId), includeInactive === "1" ? undefined : eq(people.isActive, true), q ? or(ilike(people.name, `%${q}%`), ilike(people.company, `%${q}%`), ilike(people.role, `%${q}%`)) : undefined))
      .orderBy(asc(people.name))
      .limit(500);
    return c.json(rows.map((r) => dto(r.p, r.openTasks)), 200);
  },
);

peopleRoutes.openapi(
  createRoute({
    method: "post",
    path: "/",
    tags: ["people"],
    summary: "Добавить человека (если имя уже есть — вернёт существующего)",
    request: { body: { content: { "application/json": { schema: PersonBody } } } },
    responses: { 201: { description: "OK", content: { "application/json": { schema: PersonSchema } } } },
  }),
  async (c) => {
    const u = c.get("user");
    const body = c.req.valid("json");
    const p = await findOrCreatePerson(body.name, { source: "manual", createdBy: u.id, agencyId: u.agencyId, organizationId: c.get("org")?.id ?? null, role: body.role, company: body.company, email: body.email });
    // Дозаполняем пустые поля у существующего
    const patch: Partial<typeof people.$inferSelect> = {};
    if (!p.role && body.role) patch.role = body.role;
    if (!p.company && body.company) patch.company = body.company;
    if (!p.email && body.email) patch.email = body.email.toLowerCase();
    const [updated] = Object.keys(patch).length ? await db().update(people).set(patch).where(eq(people.id, p.id)).returning() : [p];
    return c.json(dto(updated!), 201);
  },
);

peopleRoutes.openapi(
  createRoute({
    method: "patch",
    path: "/{id}",
    tags: ["people"],
    summary: "Изменить человека",
    request: { params: IdParam, body: { content: { "application/json": { schema: PersonBody.partial().extend({ isActive: z.boolean().optional() }) } } } },
    responses: { 200: { description: "OK", content: { "application/json": { schema: PersonSchema } } }, 404: { description: "Не найдено", content: { "application/json": { schema: ErrorSchema } } } },
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const [p] = await db().select().from(people).where(eq(people.id, id)).limit(1);
    if (!p) throw new HTTPException(404, { message: "Человек не найден" });
    const patch: Partial<typeof people.$inferSelect> = {};
    if (body.name !== undefined) {
      patch.name = body.name;
      patch.normalizedName = normalizeName(body.name);
    }
    if (body.role !== undefined) patch.role = body.role;
    if (body.company !== undefined) patch.company = body.company;
    if (body.email !== undefined) patch.email = body.email?.toLowerCase() ?? null;
    if (body.isActive !== undefined) patch.isActive = body.isActive;
    try {
      const [updated] = await db().update(people).set(patch).where(eq(people.id, id)).returning();
      if (patch.name) await db().update(tasks).set({ assigneeName: patch.name }).where(eq(tasks.assigneePersonId, id));
      return c.json(dto(updated!), 200);
    } catch (e) {
      if ((e as { code?: string }).code === "23505") throw new HTTPException(409, { message: "Человек с таким именем уже есть" });
      throw e;
    }
  },
);

peopleRoutes.openapi(
  createRoute({
    method: "delete",
    path: "/{id}",
    tags: ["people"],
    summary: "Скрыть человека из справочника (задачи сохраняют имя)",
    request: { params: IdParam },
    responses: { 200: { description: "OK", content: { "application/json": { schema: z.object({ ok: z.boolean() }) } } } },
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    await db().update(people).set({ isActive: false }).where(eq(people.id, id));
    return c.json({ ok: true }, 200);
  },
);
