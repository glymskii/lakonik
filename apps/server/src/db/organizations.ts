import { randomBytes } from "node:crypto";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { db, type Db } from "./client.js";
import { agencies, meetingTemplates, meetings, members, organizationDomains, organizations, people, settings, tasks, usageEvents, user } from "./schema/index.js";
import type { OrgSettings } from "./types.js";
import { seedLegacyTemplates } from "./seed.js";
import { catalog } from "../templates/catalog.js";

type Tx = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

export const newInviteToken = () => randomBytes(16).toString("base64url");

/** Публичные почтовые домены: организация не может «владеть» ими, автовступление по ним невозможно */
export const PUBLIC_EMAIL_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "icloud.com", "me.com", "mac.com", "outlook.com", "hotmail.com", "live.com", "yahoo.com",
  "mail.ru", "bk.ru", "list.ru", "inbox.ru", "yandex.ru", "yandex.kz", "yandex.com", "ya.ru", "proton.me", "protonmail.com", "privaterelay.appleid.com",
]);

export function emailDomainOf(email: string): string {
  return email.split("@")[1]?.toLowerCase() ?? "";
}

export function isPublicDomain(domain: string): boolean {
  return PUBLIC_EMAIL_DOMAINS.has(domain) || domain.endsWith(".appleid.com");
}

/** Личное пространство пользователя (создаётся при регистрации; для существующих — переносом) */
export async function ensurePersonalOrg(tx: Tx, u: { id: string; name: string; email: string }): Promise<string> {
  const [existing] = await tx
    .select({ id: organizations.id })
    .from(members)
    .innerJoin(organizations, eq(organizations.id, members.organizationId))
    .where(and(eq(members.userId, u.id), eq(organizations.kind, "personal")))
    .limit(1);
  if (existing) return existing.id;
  const [org] = await tx
    .insert(organizations)
    .values({ name: u.name?.trim() || u.email.split("@")[0] || "Личное", kind: "personal", inviteToken: newInviteToken(), createdBy: u.id })
    .returning({ id: organizations.id });
  await tx.insert(members).values({ organizationId: org!.id, userId: u.id, role: "owner" }).onConflictDoNothing();
  return org!.id;
}

/** Автовступление: организации с подтверждённым доменом почты и включённым allowDomainJoin */
export async function joinByDomain(tx: Tx, u: { id: string; email: string }): Promise<string[]> {
  const domain = emailDomainOf(u.email);
  if (!domain || isPublicDomain(domain)) return [];
  const orgs = await tx
    .select({ id: organizations.id, seats: organizations.planSeats })
    .from(organizationDomains)
    .innerJoin(organizations, eq(organizations.id, organizationDomains.organizationId))
    .where(and(eq(organizationDomains.domain, domain), eq(organizationDomains.verified, true), eq(organizations.allowDomainJoin, true)));
  const joined: string[] = [];
  for (const o of orgs) {
    await tx.insert(members).values({ organizationId: o.id, userId: u.id, role: "member" }).onConflictDoNothing();
    joined.push(o.id);
  }
  return joined;
}

/**
 * Старый каталог одиночного контура становится приватным каталогом организации переноса.
 * Встречи ссылаются на шаблоны по id, поэтому ничего не теряется; системный «Без типа» остаётся встроенным.
 *
 * Признак того, что в слоте встроенных шаблонов всё ещё лежит старый каталог: есть код, которого нет
 * во встроенном каталоге 1.0. Если встроенные — уже новый каталог (или их нет вовсе), не трогаем ничего,
 * поэтому шаг идемпотентен и безопасен на любом старте.
 */
async function convertBuiltinTemplatesToLegacy(tx: Tx, legacyId: string): Promise<number> {
  const rows = await tx
    .select({ code: meetingTemplates.code })
    .from(meetingTemplates)
    .where(and(isNull(meetingTemplates.organizationId), sql`${meetingTemplates.group} <> 'system'`));
  if (!rows.length) return 0;
  const builtinCodes = new Set(catalog.templates.map((t) => t.code));
  if (rows.every((r) => builtinCodes.has(r.code))) return 0;
  const r = await tx.execute(
    sql`update meeting_templates set organization_id = ${legacyId}, updated_at = now() where organization_id is null and "group" <> 'system'`,
  );
  logger.info({ legacyId, templates: r.rowCount ?? 0 }, "Шаблоны одиночного контура переведены в приватный каталог организации переноса");
  return r.rowCount ?? 0;
}

/**
 * Перенос одиночного контура в организации. Идемпотентно, в одной транзакции, выполняется при каждом старте API
 * после миграций схемы:
 *  1) LEGACY_ORG_NAME задан → единая организация для всех существующих пользователей (агентства ADV / self-hosted сервер):
 *     план, места и срок из окружения, домены — из agencies и ALLOWED_EMAIL_DOMAINS, сроки и словарь STT — из старых настроек;
 *  2) каждому пользователю — личное пространство;
 *  3) встречи, задачи, люди и usage без organization_id получают организацию (legacy, иначе личную владельца);
 *  4) каталог: старые шаблоны одиночного контура становятся приватным каталогом организации переноса,
 *     после чего ей досеивается каталог из templates-adv.json (на свежей базе self-hosted сервера).
 */
export async function backfillOrganizations(): Promise<void> {
  const cfg = config();
  let legacyOrgId: string | null = null;
  await db().transaction(async (tx) => {
    const users = await tx.select({ id: user.id, name: user.name, email: user.email, role: user.role }).from(user);

    // 1. Организация переноса
    let legacyId: string | null = null;
    const [legacy] = await tx.select({ id: organizations.id }).from(organizations).where(sql`${organizations.settings} ->> 'legacy' = 'true'`).limit(1);
    if (legacy) legacyId = legacy.id;
    else if (cfg.LEGACY_ORG_NAME) {
      const ownerEmail = cfg.LEGACY_ORG_OWNER_EMAIL?.toLowerCase();
      const owner = ownerEmail ? users.find((x) => x.email.toLowerCase() === ownerEmail) : undefined;
      if (!owner) {
        logger.warn({ ownerEmail }, "LEGACY_ORG_NAME задан, но владелец (LEGACY_ORG_OWNER_EMAIL) не найден среди пользователей — организация не создана");
      } else {
        const [global] = await tx.select().from(settings).where(eq(settings.id, "global")).limit(1);
        const ags = await tx.select().from(agencies);
        const orgSettings: OrgSettings = { legacy: true, deadlines: global?.deadlines ?? {}, keyterms: [...new Set(ags.flatMap((a) => a.keyterms))] };
        const [org] = await tx
          .insert(organizations)
          .values({
            name: cfg.LEGACY_ORG_NAME,
            kind: "team",
            plan: cfg.LEGACY_ORG_PLAN,
            planSeats: cfg.LEGACY_ORG_SEATS ?? null,
            planUntil: cfg.LEGACY_ORG_UNTIL ? new Date(`${cfg.LEGACY_ORG_UNTIL}T23:59:59+05:00`) : null,
            inviteToken: newInviteToken(),
            allowDomainJoin: true,
            settings: orgSettings,
            createdBy: owner.id,
          })
          .returning({ id: organizations.id });
        legacyId = org!.id;
        const domains = [...new Set([...ags.flatMap((a) => a.emailDomains), ...cfg.ALLOWED_EMAIL_DOMAINS].map((d) => d.toLowerCase()).filter((d) => d && !isPublicDomain(d)))];
        if (domains.length) await tx.insert(organizationDomains).values(domains.map((domain) => ({ organizationId: legacyId!, domain, verified: true }))).onConflictDoNothing();
        logger.info({ name: cfg.LEGACY_ORG_NAME, domains, owner: owner.email }, "Создана организация переноса");
      }
    }
    if (legacyId) await convertBuiltinTemplatesToLegacy(tx, legacyId);
    if (legacyId && users.length) {
      const ownerEmail = cfg.LEGACY_ORG_OWNER_EMAIL?.toLowerCase();
      await tx
        .insert(members)
        .values(users.map((x) => ({ organizationId: legacyId!, userId: x.id, role: x.email.toLowerCase() === ownerEmail ? ("owner" as const) : x.role === "holding_admin" || x.role === "agency_admin" ? ("admin" as const) : ("member" as const) })))
        .onConflictDoNothing();
    }

    // 2. Личные пространства
    const personalByUser = new Map<string, string>();
    for (const x of users) personalByUser.set(x.id, await ensurePersonalOrg(tx, x));

    // 3. Данные без организации
    let moved = 0;
    if (legacyId) {
      const r1 = await tx.update(meetings).set({ organizationId: legacyId }).where(isNull(meetings.organizationId));
      const r2 = await tx.update(people).set({ organizationId: legacyId }).where(isNull(people.organizationId));
      moved += (r1.rowCount ?? 0) + (r2.rowCount ?? 0);
    } else {
      for (const [userId, orgId] of personalByUser) {
        const r = await tx.update(meetings).set({ organizationId: orgId }).where(and(isNull(meetings.organizationId), eq(meetings.ownerId, userId)));
        const p = await tx.update(people).set({ organizationId: orgId }).where(and(isNull(people.organizationId), eq(people.createdBy, userId)));
        moved += (r.rowCount ?? 0) + (p.rowCount ?? 0);
      }
    }
    const rt = await tx.execute(sql`update tasks t set organization_id = m.organization_id from meetings m where t.meeting_id = m.id and t.organization_id is null and m.organization_id is not null`);
    const ru = await tx.execute(sql`update usage_events u set organization_id = m.organization_id from meetings m where u.meeting_id = m.id and u.organization_id is null and m.organization_id is not null`);
    moved += (rt.rowCount ?? 0) + (ru.rowCount ?? 0);
    // Расход по уже удалённым встречам (meeting_id = null) — в организацию переноса, чтобы статистика не терялась
    if (legacyId) {
      const ro = await tx.update(usageEvents).set({ organizationId: legacyId }).where(isNull(usageEvents.organizationId));
      moved += ro.rowCount ?? 0;
    }
    if (moved || !legacy) logger.info({ users: users.length, legacyOrg: legacyId, moved }, "Организации: перенос данных выполнен");
    legacyOrgId = legacyId;
  });
  // Приватный каталог организации переноса: на свежей базе (self-hosted сервер) даёт ей её шаблоны,
  // на проде no-op — там шаблоны уже стали приватными при создании организации. Идемпотентно на каждом старте.
  if (legacyOrgId) await seedLegacyTemplates(legacyOrgId);
}

/** Организация по умолчанию для клиентов без заголовка X-Organization-Id (старые сборки): командная организация переноса → единственная командная → личная */
export async function defaultOrganizationFor(userId: string): Promise<string | null> {
  const rows = await db()
    .select({ id: organizations.id, kind: organizations.kind, legacy: sql<boolean>`coalesce((${organizations.settings} ->> 'legacy')::boolean, false)` })
    .from(members)
    .innerJoin(organizations, eq(organizations.id, members.organizationId))
    .where(eq(members.userId, userId));
  const teams = rows.filter((r) => r.kind === "team");
  return teams.find((r) => r.legacy)?.id ?? (teams.length === 1 ? teams[0]!.id : rows.find((r) => r.kind === "personal")?.id ?? null);
}

export async function membershipsOf(userId: string) {
  return db()
    .select({ org: organizations, role: members.role })
    .from(members)
    .innerJoin(organizations, eq(organizations.id, members.organizationId))
    .where(eq(members.userId, userId))
    .orderBy(sql`case when ${organizations.kind} = 'personal' then 0 else 1 end`, organizations.name);
}

export async function orgIdsOf(userId: string): Promise<string[]> {
  const rows = await db().select({ id: members.organizationId }).from(members).where(eq(members.userId, userId));
  return rows.map((r) => r.id);
}

export { inArray };
