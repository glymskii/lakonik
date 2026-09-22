import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { track } from "../../analytics/amplitude.js";
import { db } from "../../db/client.js";
import { agencies, devices, organizations, user as userTable } from "../../db/schema/index.js";
import { and, asc, ilike, or } from "drizzle-orm";
import { logger } from "../../logger.js";
import { revokeAppleTokens } from "../../auth/apple-revoke.js";
import { requireUser, type AppEnv } from "../middleware/auth.js";
import { withOrg } from "../middleware/org.js";
import { defaultOrganizationFor, membershipsOf } from "../../db/organizations.js";
import { members } from "../../db/schema/index.js";
import { sql } from "drizzle-orm";
import { removeMember } from "./organizations.js";
import { DeleteAccountConflictSchema, DeviceBody, ErrorSchema, MeSchema, AccountUserSchema } from "../schemas.js";
import { z } from "@hono/zod-openapi";

export const meRoutes = new OpenAPIHono<AppEnv>();
meRoutes.use("*", requireUser);

meRoutes.openapi(
  createRoute({
    method: "get",
    path: "/",
    tags: ["me"],
    summary: "Текущий пользователь",
    responses: { 200: { description: "OK", content: { "application/json": { schema: MeSchema } } } },
  }),
  async (c) => {
    const u = c.get("user");
    let agencyName: string | null = null;
    if (u.agencyId) {
      const [a] = await db().select({ name: agencies.name }).from(agencies).where(eq(agencies.id, u.agencyId)).limit(1);
      agencyName = a?.name ?? null;
    }
    const rows = await membershipsOf(u.id);
    const counts = rows.length
      ? await db().select({ id: members.organizationId, n: sql<number>`count(*)::int` }).from(members).where(sql`${members.organizationId} in ${rows.map((r) => r.org.id)}`).groupBy(members.organizationId)
      : [];
    const countById = new Map(counts.map((x) => [x.id, x.n]));
    const organizations = rows.map((r) => ({
      id: r.org.id,
      name: r.org.name,
      kind: r.org.kind,
      role: r.role,
      plan: r.org.plan,
      planSeats: r.org.planSeats,
      planUntil: r.org.planUntil ? r.org.planUntil.toISOString() : null,
      membersCount: countById.get(r.org.id) ?? 1,
    }));
    return c.json({ id: u.id, email: u.email, name: u.name, image: u.image, role: u.role, agencyId: u.agencyId, agencyName, organizations, defaultOrganizationId: await defaultOrganizationFor(u.id) }, 200);
  },
);

meRoutes.openapi(
  createRoute({
    method: "post",
    path: "/devices",
    tags: ["me"],
    summary: "Зарегистрировать push-токен устройства",
    request: { body: { content: { "application/json": { schema: DeviceBody } } } },
    responses: { 200: { description: "OK", content: { "application/json": { schema: z.object({ ok: z.boolean() }) } } } },
  }),
  async (c) => {
    const u = c.get("user");
    const body = c.req.valid("json");
    await db()
      .insert(devices)
      .values({ userId: u.id, platform: body.platform, pushToken: body.pushToken, appVersion: body.appVersion ?? null, lastSeenAt: new Date() })
      .onConflictDoUpdate({ target: devices.pushToken, set: { userId: u.id, platform: body.platform, appVersion: body.appVersion ?? null, lastSeenAt: new Date() } });
    return c.json({ ok: true }, 200);
  },
);

meRoutes.openapi(
  createRoute({
    method: "delete",
    path: "/devices/{token}",
    tags: ["me"],
    summary: "Удалить push-токен (выход)",
    request: { params: z.object({ token: z.string() }) },
    responses: { 200: { description: "OK", content: { "application/json": { schema: z.object({ ok: z.boolean() }) } } } },
  }),
  async (c) => {
    const { token } = c.req.valid("param");
    await db().delete(devices).where(eq(devices.pushToken, token));
    return c.json({ ok: true }, 200);
  },
);

// ---------- Удаление аккаунта ----------

meRoutes.openapi(
  createRoute({
    method: "delete",
    path: "/",
    tags: ["me"],
    summary: "Удалить аккаунт со всеми данными (личное пространство, встречи, задачи)",
    responses: {
      200: { description: "Удалено", content: { "application/json": { schema: z.object({ ok: z.boolean() }) } } },
      409: { description: "Пользователь — единственный владелец организации с участниками", content: { "application/json": { schema: DeleteAccountConflictSchema } } },
      401: { description: "Требуется вход", content: { "application/json": { schema: ErrorSchema } } },
    },
  }),
  async (c) => {
    const u = c.get("user");
    const d = db();
    const rows = await d
      .select({
        id: organizations.id,
        name: organizations.name,
        kind: organizations.kind,
        role: members.role,
        membersCount: sql<number>`(select count(*) from ${members} m where m.organization_id = ${organizations.id})::int`,
        ownerId: sql<string | null>`(select m.user_id from ${members} m where m.organization_id = ${organizations.id} and m.role = 'owner' and m.user_id <> ${u.id} limit 1)`,
      })
      .from(members)
      .innerJoin(organizations, eq(organizations.id, members.organizationId))
      .where(eq(members.userId, u.id));

    const teams = rows.filter((r) => r.kind === "team");
    // Единственный владелец организации, где есть другие участники: сначала передать владение или удалить организацию
    const blocking = teams.filter((r) => r.role === "owner" && r.membersCount > 1);
    if (blocking.length) {
      const names = blocking.map((o) => `«${o.name}»`).join(", ");
      throw new HTTPException(409, {
        message: `Вы единственный владелец организации ${names}. Передайте владение другому участнику или удалите организацию — после этого аккаунт можно будет удалить.`,
        res: Response.json(
          {
            error: `Вы единственный владелец организации ${names}. Передайте владение другому участнику или удалите организацию — после этого аккаунт можно будет удалить.`,
            code: "account.sole_owner",
            organizations: blocking.map((o) => ({ id: o.id, name: o.name })),
          },
          { status: 409 },
        ),
      });
    }

    // Отзыв токена Apple — до удаления аккаунта, пока в таблице account есть токены
    const apple = await revokeAppleTokens(u.id);

    await d.transaction(async (tx) => {
      for (const org of rows) {
        if (org.kind === "personal" || org.membersCount <= 1) {
          // Личное пространство и командные организации, где пользователь был один, удаляются со всеми данными
          await tx.delete(organizations).where(eq(organizations.id, org.id));
          continue;
        }
        // Участник или администратор: встречи уходят владельцу организации (конфиденциальные удаляются)
        await removeMember(tx, org.id, u.id, org.ownerId ?? null);
      }
      await tx.delete(devices).where(eq(devices.userId, u.id));
      // Каскад удалит сессии, привязки провайдеров, подписки и остатки данных пользователя
      await tx.delete(userTable).where(eq(userTable.id, u.id));
    });

    track(u.id, "account_deleted", { organizations: teams.length, appleRevoked: apple.revoked });
    logger.info({ userId: u.id, email: u.email, organizations: rows.length, appleRevoked: apple.revoked, appleSkipped: apple.skipped }, "Аккаунт удалён");
    return c.json({ ok: true }, 200);
  },
);

/** Справочник аккаунтов холдинга: для выбора спикеров и шаринга. */
export const usersRoutes = new OpenAPIHono<AppEnv>();
usersRoutes.use("*", requireUser);
usersRoutes.use("*", withOrg);

usersRoutes.openapi(
  createRoute({
    method: "get",
    path: "/",
    tags: ["users"],
    summary: "Участники текущего пространства (имя, почта)",
    request: { query: z.object({ q: z.string().max(80).optional() }) },
    responses: { 200: { description: "OK", content: { "application/json": { schema: z.array(AccountUserSchema) } } } },
  }),
  async (c) => {
    const { q } = c.req.valid("query");
    const org = c.get("org");
    const rows = await db()
      .select({ id: userTable.id, name: userTable.name, email: userTable.email, agencyId: userTable.agencyId, agencyName: agencies.name })
      .from(userTable)
      .leftJoin(agencies, eq(agencies.id, userTable.agencyId))
      .where(and(org ? sql`${userTable.id} in (select user_id from members where organization_id = ${org.id})` : undefined, q ? or(ilike(userTable.name, `%${q}%`), ilike(userTable.email, `%${q}%`)) : undefined))
      .orderBy(asc(userTable.name), asc(userTable.email))
      .limit(500);
    return c.json(rows.map((r) => ({ id: r.id, name: r.name, email: r.email, agencyId: r.agencyId, agencyName: r.agencyName ?? null })), 200);
  },
);
