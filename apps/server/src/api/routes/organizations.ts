import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { and, asc, eq, gt, inArray, ne, sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { track } from "../../analytics/amplitude.js";
import { config } from "../../config.js";
import { db, type Db } from "../../db/client.js";
import { emailDomainOf, isPublicDomain, newInviteToken } from "../../db/organizations.js";
import { invitations, meetings, members, organizationDomains, organizations, tasks, user as userTable } from "../../db/schema/index.js";
import { inviteEmail, sendMail } from "../../email/mailer.js";
import { logger } from "../../logger.js";
import { requireUser, type AppEnv, type SessionUser } from "../middleware/auth.js";
import { CreateOrgBody, ErrorSchema, InviteBody, JoinInfoSchema, MemberRoleBody, OrganizationBriefSchema, OrganizationSchema, OrgMemberSchema, PatchOrgBody, RemoveMemberBody, SuggestedOrgSchema, TransferBody } from "../schemas.js";

/**
 * Организации (командные пространства): создание, карточка, участники, приглашения по ссылке и почте,
 * автовступление по домену, передача владения, выход и удаление. Личное пространство здесь не создаётся
 * и не удаляется — оно живёт вместе с аккаунтом.
 */
export const organizationsRoutes = new OpenAPIHono<AppEnv>();
organizationsRoutes.use("*", requireUser);

type Tx = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];
type Role = "owner" | "admin" | "member";
const IdParam = z.object({ id: z.string().uuid() });
const isAdmin = (r: Role) => r === "owner" || r === "admin";

async function membership(orgId: string, userId: string) {
  const [row] = await db().select({ org: organizations, role: members.role }).from(members).innerJoin(organizations, eq(organizations.id, members.organizationId)).where(and(eq(members.organizationId, orgId), eq(members.userId, userId))).limit(1);
  if (!row) throw new HTTPException(404, { message: "Организация не найдена" });
  return row;
}

function requireAdmin(role: Role) {
  if (!isAdmin(role)) throw new HTTPException(403, { message: "Действие доступно администратору организации" });
}

async function membersCount(tx: Tx, orgId: string): Promise<number> {
  const [r] = await tx.select({ n: sql<number>`count(*)::int` }).from(members).where(eq(members.organizationId, orgId));
  return r?.n ?? 0;
}

/** Enterprise: число участников ограничено местами плана (после окончания плана — как free, без ограничения мест) */
async function assertSeats(tx: Tx, org: { id: string; plan: string; planSeats: number | null; planUntil: Date | null }) {
  if (org.plan !== "enterprise" || !org.planSeats) return;
  if (org.planUntil && org.planUntil < new Date()) return;
  if ((await membersCount(tx, org.id)) >= org.planSeats) throw new HTTPException(409, { message: `В организации заняты все ${org.planSeats} мест плана — обратитесь к владельцу`, cause: { code: "plan.seats" } });
}

async function orgDto(orgId: string, me: { id: string; role: Role }) {
  const d = db();
  const [org] = await d.select().from(organizations).where(eq(organizations.id, orgId)).limit(1);
  if (!org) throw new HTTPException(404, { message: "Организация не найдена" });
  const rows = await d
    .select({ userId: members.userId, name: userTable.name, email: userTable.email, role: members.role, joinedAt: members.createdAt })
    .from(members)
    .innerJoin(userTable, eq(userTable.id, members.userId))
    .where(eq(members.organizationId, orgId))
    .orderBy(sql`case ${members.role} when 'owner' then 0 when 'admin' then 1 else 2 end`, asc(userTable.name));
  const domains = await d.select({ domain: organizationDomains.domain, verified: organizationDomains.verified }).from(organizationDomains).where(eq(organizationDomains.organizationId, orgId)).orderBy(asc(organizationDomains.domain));
  const pending = isAdmin(me.role)
    ? await d.select({ id: invitations.id, email: invitations.email, role: invitations.role, expiresAt: invitations.expiresAt }).from(invitations).where(and(eq(invitations.organizationId, orgId), eq(invitations.status, "pending"), gt(invitations.expiresAt, new Date()))).orderBy(asc(invitations.email))
    : [];
  return {
    id: org.id,
    name: org.name,
    kind: org.kind,
    plan: org.plan,
    planSeats: org.planSeats,
    planUntil: org.planUntil ? org.planUntil.toISOString() : null,
    role: me.role,
    allowDomainJoin: org.allowDomainJoin,
    inviteLink: isAdmin(me.role) && org.kind === "team" ? `${config().SITE_URL}/join/${org.inviteToken}` : null,
    domains,
    membersCount: rows.length,
    members: rows.map((r) => ({ ...r, joinedAt: r.joinedAt.toISOString() })),
    keyterms: org.settings.keyterms ?? [],
    pendingInvitations: pending.map((p) => ({ ...p, expiresAt: p.expiresAt.toISOString() })),
  };
}

const briefDto = (org: typeof organizations.$inferSelect, role: Role, membersCount: number) => ({
  id: org.id,
  name: org.name,
  kind: org.kind,
  role,
  plan: org.plan,
  planSeats: org.planSeats,
  planUntil: org.planUntil ? org.planUntil.toISOString() : null,
  membersCount,
});

/**
 * Удаление участника из организации: конфиденциальные встречи удаляются, остальные передаются transferTo
 * (с пометкой orphanedFrom) или удаляются; задачи следуют за встречами; членство снимается.
 */
async function removeMember(tx: Tx, orgId: string, targetUserId: string, transferTo: string | null) {
  const mine = tx.select({ id: meetings.id }).from(meetings).where(and(eq(meetings.organizationId, orgId), eq(meetings.ownerId, targetUserId)));
  await tx.delete(meetings).where(and(eq(meetings.organizationId, orgId), eq(meetings.ownerId, targetUserId), eq(meetings.confidentiality, "restricted")));
  if (transferTo) {
    const ids = (await mine).map((m) => m.id);
    if (ids.length) {
      await tx.update(meetings).set({ ownerId: transferTo, orphanedFrom: targetUserId }).where(inArray(meetings.id, ids));
      await tx.update(tasks).set({ ownerId: transferTo }).where(inArray(tasks.meetingId, ids));
    }
  } else {
    await tx.delete(meetings).where(and(eq(meetings.organizationId, orgId), eq(meetings.ownerId, targetUserId)));
  }
  await tx.delete(invitations).where(and(eq(invitations.organizationId, orgId), eq(invitations.inviterId, targetUserId), eq(invitations.status, "pending")));
  await tx.delete(members).where(and(eq(members.organizationId, orgId), eq(members.userId, targetUserId)));
}

// ---------- Создание и предложения по домену ----------

organizationsRoutes.openapi(
  createRoute({
    method: "post",
    path: "/",
    tags: ["organizations"],
    summary: "Создать организацию (создатель — владелец; его домен почты подтверждается автоматически)",
    request: { body: { content: { "application/json": { schema: CreateOrgBody } } } },
    responses: { 201: { description: "Создано", content: { "application/json": { schema: OrganizationSchema } } } },
  }),
  async (c) => {
    const u = c.get("user");
    const { name } = c.req.valid("json");
    const orgId = await db().transaction(async (tx) => {
      const [org] = await tx.insert(organizations).values({ name, kind: "team", inviteToken: newInviteToken(), createdBy: u.id }).returning({ id: organizations.id });
      await tx.insert(members).values({ organizationId: org!.id, userId: u.id, role: "owner" });
      const domain = emailDomainOf(u.email);
      if (domain && !isPublicDomain(domain)) await tx.insert(organizationDomains).values({ organizationId: org!.id, domain, verified: true }).onConflictDoNothing();
      return org!.id;
    });
    track(u.id, "organization_created", { domain: isPublicDomain(emailDomainOf(u.email)) ? "public" : "corporate" });
    return c.json(await orgDto(orgId, { id: u.id, role: "owner" }), 201);
  },
);

organizationsRoutes.openapi(
  createRoute({
    method: "get",
    path: "/suggested",
    tags: ["organizations"],
    summary: "Организации, куда можно вступить по домену своей почты",
    responses: { 200: { description: "OK", content: { "application/json": { schema: z.array(SuggestedOrgSchema) } } } },
  }),
  async (c) => c.json(await suggestedFor(c.get("user")), 200),
);

async function suggestedFor(u: SessionUser) {
  const domain = emailDomainOf(u.email);
  if (!domain || isPublicDomain(domain)) return [];
  const d = db();
  const rows = await d
    .select({ id: organizations.id, name: organizations.name, membersCount: sql<number>`(select count(*) from ${members} m where m.organization_id = ${organizations.id})::int` })
    .from(organizationDomains)
    .innerJoin(organizations, eq(organizations.id, organizationDomains.organizationId))
    .where(and(eq(organizationDomains.domain, domain), eq(organizationDomains.verified, true), eq(organizations.allowDomainJoin, true), eq(organizations.kind, "team"), sql`not exists (select 1 from ${members} mm where mm.organization_id = ${organizations.id} and mm.user_id = ${u.id})`));
  return rows;
}

// ---------- Карточка ----------

organizationsRoutes.openapi(
  createRoute({
    method: "get",
    path: "/{id}",
    tags: ["organizations"],
    summary: "Карточка организации: участники, домены, ссылка-приглашение (админу), приглашения",
    request: { params: IdParam },
    responses: { 200: { description: "OK", content: { "application/json": { schema: OrganizationSchema } } }, 404: { description: "Нет доступа", content: { "application/json": { schema: ErrorSchema } } } },
  }),
  async (c) => {
    const u = c.get("user");
    const m = await membership(c.req.valid("param").id, u.id);
    return c.json(await orgDto(m.org.id, { id: u.id, role: m.role }), 200);
  },
);

organizationsRoutes.openapi(
  createRoute({
    method: "patch",
    path: "/{id}",
    tags: ["organizations"],
    summary: "Изменить название, автовступление по домену, словарь терминов (админ)",
    request: { params: IdParam, body: { content: { "application/json": { schema: PatchOrgBody } } } },
    responses: { 200: { description: "OK", content: { "application/json": { schema: OrganizationSchema } } } },
  }),
  async (c) => {
    const u = c.get("user");
    const m = await membership(c.req.valid("param").id, u.id);
    requireAdmin(m.role);
    const body = c.req.valid("json");
    const patch: Partial<typeof organizations.$inferInsert> = {};
    if (body.name !== undefined && m.org.kind === "team") patch.name = body.name;
    if (body.allowDomainJoin !== undefined) patch.allowDomainJoin = body.allowDomainJoin;
    if (body.keyterms !== undefined) patch.settings = { ...m.org.settings, keyterms: [...new Set(body.keyterms)] };
    if (Object.keys(patch).length) await db().update(organizations).set(patch).where(eq(organizations.id, m.org.id));
    return c.json(await orgDto(m.org.id, { id: u.id, role: m.role }), 200);
  },
);

organizationsRoutes.openapi(
  createRoute({
    method: "post",
    path: "/{id}/invite-link",
    tags: ["organizations"],
    summary: "Перевыпустить ссылку-приглашение (старая перестаёт работать)",
    request: { params: IdParam },
    responses: { 200: { description: "OK", content: { "application/json": { schema: z.object({ inviteLink: z.string() }) } } } },
  }),
  async (c) => {
    const u = c.get("user");
    const m = await membership(c.req.valid("param").id, u.id);
    requireAdmin(m.role);
    if (m.org.kind !== "team") throw new HTTPException(400, { message: "В личное пространство нельзя приглашать" });
    const token = newInviteToken();
    await db().update(organizations).set({ inviteToken: token }).where(eq(organizations.id, m.org.id));
    return c.json({ inviteLink: `${config().SITE_URL}/join/${token}` }, 200);
  },
);

// ---------- Приглашения по почте ----------

organizationsRoutes.openapi(
  createRoute({
    method: "post",
    path: "/{id}/invitations",
    tags: ["organizations"],
    summary: "Пригласить по почте (письмо со ссылкой, 14 дней)",
    request: { params: IdParam, body: { content: { "application/json": { schema: InviteBody } } } },
    responses: { 201: { description: "Отправлено", content: { "application/json": { schema: z.object({ id: z.string().uuid(), email: z.string(), expiresAt: z.string() }) } } } },
  }),
  async (c) => {
    const u = c.get("user");
    const m = await membership(c.req.valid("param").id, u.id);
    requireAdmin(m.role);
    if (m.org.kind !== "team") throw new HTTPException(400, { message: "В личное пространство нельзя приглашать" });
    const body = c.req.valid("json");
    const email = body.email.trim().toLowerCase();
    const [already] = await db().select({ id: members.userId }).from(members).innerJoin(userTable, eq(userTable.id, members.userId)).where(and(eq(members.organizationId, m.org.id), eq(userTable.email, email))).limit(1);
    if (already) throw new HTTPException(409, { message: "Этот человек уже в организации" });
    await assertSeats(db(), m.org);
    // Повторное приглашение заменяет прежнее ожидающее
    await db().update(invitations).set({ status: "revoked" }).where(and(eq(invitations.organizationId, m.org.id), eq(invitations.email, email), eq(invitations.status, "pending")));
    const expiresAt = new Date(Date.now() + 14 * 24 * 3600 * 1000);
    const [inv] = await db().insert(invitations).values({ organizationId: m.org.id, email, role: body.role, token: newInviteToken(), expiresAt, inviterId: u.id }).returning();
    const link = `${config().SITE_URL}/join/${inv!.token}`;
    try {
      await sendMail({ to: email, ...inviteEmail(m.org.name, u.name, link) });
    } catch (e) {
      logger.warn({ err: (e as Error).message, email }, "Письмо-приглашение не отправлено");
    }
    return c.json({ id: inv!.id, email, expiresAt: expiresAt.toISOString() }, 201);
  },
);

organizationsRoutes.openapi(
  createRoute({
    method: "delete",
    path: "/{id}/invitations/{invitationId}",
    tags: ["organizations"],
    summary: "Отозвать приглашение",
    request: { params: IdParam.extend({ invitationId: z.string().uuid() }) },
    responses: { 200: { description: "OK", content: { "application/json": { schema: z.object({ ok: z.boolean() }) } } } },
  }),
  async (c) => {
    const u = c.get("user");
    const { id, invitationId } = c.req.valid("param");
    const m = await membership(id, u.id);
    requireAdmin(m.role);
    await db().update(invitations).set({ status: "revoked" }).where(and(eq(invitations.id, invitationId), eq(invitations.organizationId, id)));
    return c.json({ ok: true }, 200);
  },
);

// ---------- Участники ----------

organizationsRoutes.openapi(
  createRoute({
    method: "get",
    path: "/{id}/members",
    tags: ["organizations"],
    summary: "Участники организации",
    request: { params: IdParam },
    responses: { 200: { description: "OK", content: { "application/json": { schema: z.array(OrgMemberSchema) } } } },
  }),
  async (c) => {
    const u = c.get("user");
    const m = await membership(c.req.valid("param").id, u.id);
    return c.json((await orgDto(m.org.id, { id: u.id, role: m.role })).members, 200);
  },
);

organizationsRoutes.openapi(
  createRoute({
    method: "patch",
    path: "/{id}/members/{userId}",
    tags: ["organizations"],
    summary: "Изменить роль участника: owner — любую (кроме владения), admin — member↔admin",
    request: { params: IdParam.extend({ userId: z.string() }), body: { content: { "application/json": { schema: MemberRoleBody } } } },
    responses: { 200: { description: "OK", content: { "application/json": { schema: OrgMemberSchema } } } },
  }),
  async (c) => {
    const u = c.get("user");
    const { id, userId } = c.req.valid("param");
    const { role } = c.req.valid("json");
    const m = await membership(id, u.id);
    requireAdmin(m.role);
    const target = await membership(id, userId).catch(() => null);
    if (!target) throw new HTTPException(404, { message: "Участник не найден" });
    if (target.role === "owner") throw new HTTPException(403, { message: "Роль владельца меняется передачей владения" });
    if (userId === u.id) throw new HTTPException(400, { message: "Свою роль изменить нельзя" });
    await db().update(members).set({ role }).where(and(eq(members.organizationId, id), eq(members.userId, userId)));
    const dto = (await orgDto(id, { id: u.id, role: m.role })).members.find((x) => x.userId === userId)!;
    return c.json(dto, 200);
  },
);

organizationsRoutes.openapi(
  createRoute({
    method: "delete",
    path: "/{id}/members/{userId}",
    tags: ["organizations"],
    summary: "Удалить участника: его встречи передать transferTo или удалить (конфиденциальные удаляются всегда)",
    request: { params: IdParam.extend({ userId: z.string() }), body: { content: { "application/json": { schema: RemoveMemberBody } }, required: false } },
    responses: { 200: { description: "OK", content: { "application/json": { schema: z.object({ ok: z.boolean() }) } } } },
  }),
  async (c) => {
    const u = c.get("user");
    const { id, userId } = c.req.valid("param");
    const body = (await c.req.json().catch(() => ({}))) as { transferTo?: string };
    const m = await membership(id, u.id);
    requireAdmin(m.role);
    if (userId === u.id) throw new HTTPException(400, { message: "Чтобы уйти самому, используйте «Покинуть организацию»" });
    const target = await membership(id, userId).catch(() => null);
    if (!target) throw new HTTPException(404, { message: "Участник не найден" });
    if (target.role === "owner") throw new HTTPException(403, { message: "Владельца удалить нельзя" });
    if (target.role === "admin" && m.role !== "owner") throw new HTTPException(403, { message: "Удалить администратора может только владелец" });
    if (body.transferTo) {
      if (body.transferTo === userId) throw new HTTPException(400, { message: "Нельзя передать встречи удаляемому участнику" });
      await membership(id, body.transferTo).catch(() => { throw new HTTPException(404, { message: "Получатель встреч не состоит в организации" }); });
    }
    await db().transaction((tx) => removeMember(tx, id, userId, body.transferTo ?? null));
    return c.json({ ok: true }, 200);
  },
);

organizationsRoutes.openapi(
  createRoute({
    method: "post",
    path: "/{id}/transfer",
    tags: ["organizations"],
    summary: "Передать владение (владелец становится админом)",
    request: { params: IdParam, body: { content: { "application/json": { schema: TransferBody } } } },
    responses: { 200: { description: "OK", content: { "application/json": { schema: OrganizationSchema } } } },
  }),
  async (c) => {
    const u = c.get("user");
    const { id } = c.req.valid("param");
    const { toUserId } = c.req.valid("json");
    const m = await membership(id, u.id);
    if (m.role !== "owner") throw new HTTPException(403, { message: "Передать владение может только владелец" });
    if (toUserId === u.id) throw new HTTPException(400, { message: "Вы уже владелец" });
    await membership(id, toUserId).catch(() => { throw new HTTPException(404, { message: "Участник не найден" }); });
    await db().transaction(async (tx) => {
      await tx.update(members).set({ role: "admin" }).where(and(eq(members.organizationId, id), eq(members.userId, u.id)));
      await tx.update(members).set({ role: "owner" }).where(and(eq(members.organizationId, id), eq(members.userId, toUserId)));
    });
    return c.json(await orgDto(id, { id: u.id, role: "admin" }), 200);
  },
);

organizationsRoutes.openapi(
  createRoute({
    method: "post",
    path: "/{id}/leave",
    tags: ["organizations"],
    summary: "Покинуть организацию: встречи передаются владельцу (конфиденциальные удаляются)",
    request: { params: IdParam },
    responses: { 200: { description: "OK", content: { "application/json": { schema: z.object({ ok: z.boolean() }) } } } },
  }),
  async (c) => {
    const u = c.get("user");
    const { id } = c.req.valid("param");
    const m = await membership(id, u.id);
    if (m.org.kind !== "team") throw new HTTPException(400, { message: "Личное пространство нельзя покинуть" });
    if (m.role === "owner") throw new HTTPException(409, { message: "Сначала передайте владение другому участнику или удалите организацию" });
    const [owner] = await db().select({ userId: members.userId }).from(members).where(and(eq(members.organizationId, id), eq(members.role, "owner"))).limit(1);
    await db().transaction((tx) => removeMember(tx, id, u.id, owner?.userId ?? null));
    return c.json({ ok: true }, 200);
  },
);

organizationsRoutes.openapi(
  createRoute({
    method: "delete",
    path: "/{id}",
    tags: ["organizations"],
    summary: "Удалить организацию со всеми данными (владелец)",
    request: { params: IdParam },
    responses: { 200: { description: "OK", content: { "application/json": { schema: z.object({ ok: z.boolean() }) } } } },
  }),
  async (c) => {
    const u = c.get("user");
    const { id } = c.req.valid("param");
    const m = await membership(id, u.id);
    if (m.org.kind !== "team") throw new HTTPException(400, { message: "Личное пространство удаляется вместе с аккаунтом" });
    if (m.role !== "owner") throw new HTTPException(403, { message: "Удалить организацию может только владелец" });
    await db().delete(organizations).where(eq(organizations.id, id));
    logger.info({ orgId: id, by: u.email }, "Организация удалена");
    return c.json({ ok: true }, 200);
  },
);

organizationsRoutes.openapi(
  createRoute({
    method: "post",
    path: "/{id}/join",
    tags: ["organizations"],
    summary: "Вступить по домену почты (организация должна быть в списке предложенных)",
    request: { params: IdParam },
    responses: { 200: { description: "OK", content: { "application/json": { schema: OrganizationBriefSchema } } } },
  }),
  async (c) => {
    const u = c.get("user");
    const { id } = c.req.valid("param");
    const ok = (await suggestedFor(u)).some((o) => o.id === id);
    if (!ok) throw new HTTPException(403, { message: "Вступление по домену для этой организации недоступно" });
    const [org] = await db().select().from(organizations).where(eq(organizations.id, id)).limit(1);
    if (!org) throw new HTTPException(404, { message: "Организация не найдена" });
    await db().transaction(async (tx) => {
      await assertSeats(tx, org);
      await tx.insert(members).values({ organizationId: id, userId: u.id, role: "member" }).onConflictDoNothing();
    });
    track(u.id, "invite_accepted", { via: "domain" });
    return c.json(briefDto(org, "member", await membersCount(db(), id)), 200);
  },
);

// ---------- Вступление по ссылке (сайт lakonik.app/join/<token> и приложение) ----------

export const joinRoutes = new OpenAPIHono<AppEnv>();

async function resolveToken(token: string) {
  const d = db();
  const [org] = await d.select().from(organizations).where(and(eq(organizations.inviteToken, token), eq(organizations.kind, "team"))).limit(1);
  if (org) return { org, invitation: null as typeof invitations.$inferSelect | null };
  const [inv] = await d.select().from(invitations).where(and(eq(invitations.token, token), eq(invitations.status, "pending"), gt(invitations.expiresAt, new Date()))).limit(1);
  if (!inv) return null;
  const [o] = await d.select().from(organizations).where(eq(organizations.id, inv.organizationId)).limit(1);
  return o ? { org: o, invitation: inv } : null;
}

joinRoutes.openapi(
  createRoute({
    method: "get",
    path: "/{token}",
    tags: ["organizations"],
    summary: "Что за приглашение (без входа): название организации и число участников",
    request: { params: z.object({ token: z.string().min(8).max(64) }) },
    responses: { 200: { description: "OK", content: { "application/json": { schema: JoinInfoSchema } } }, 404: { description: "Ссылка недействительна", content: { "application/json": { schema: ErrorSchema } } } },
  }),
  async (c) => {
    const r = await resolveToken(c.req.valid("param").token);
    if (!r) throw new HTTPException(404, { message: "Ссылка-приглашение недействительна или истекла" });
    return c.json({ organizationName: r.org.name, membersCount: await membersCount(db(), r.org.id), kind: r.invitation ? ("email" as const) : ("link" as const) }, 200);
  },
);

joinRoutes.openapi(
  createRoute({
    method: "post",
    path: "/{token}",
    tags: ["organizations"],
    summary: "Вступить по ссылке-приглашению или приглашению из письма",
    middleware: [requireUser],
    request: { params: z.object({ token: z.string().min(8).max(64) }) },
    responses: { 200: { description: "OK", content: { "application/json": { schema: OrganizationBriefSchema } } }, 404: { description: "Ссылка недействительна", content: { "application/json": { schema: ErrorSchema } } } },
  }),
  async (c) => {
    const u = c.get("user");
    const r = await resolveToken(c.req.valid("param").token);
    if (!r) throw new HTTPException(404, { message: "Ссылка-приглашение недействительна или истекла" });
    if (r.invitation && r.invitation.email !== u.email.toLowerCase()) throw new HTTPException(403, { message: `Приглашение выдано на другую почту (${r.invitation.email})` });
    const existing = await membership(r.org.id, u.id).catch(() => null);
    if (!existing) {
      await db().transaction(async (tx) => {
        await assertSeats(tx, r.org);
        await tx.insert(members).values({ organizationId: r.org.id, userId: u.id, role: r.invitation?.role ?? "member" }).onConflictDoNothing();
        if (r.invitation) await tx.update(invitations).set({ status: "accepted" }).where(eq(invitations.id, r.invitation.id));
      });
      track(u.id, "invite_accepted", { via: r.invitation ? "email" : "link" });
    }
    return c.json(briefDto(r.org, existing?.role ?? r.invitation?.role ?? "member", await membersCount(db(), r.org.id)), 200);
  },
);

export { ne };
