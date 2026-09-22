/**
 * Администрирование сервиса: планы организаций, статистика, суперадмины, ручные тарифы.
 * Работает с базой напрямую (как seed-showcase.ts); для прода — через `railway run`.
 *   pnpm --filter @lakonik/server exec tsx --env-file=.env scripts/admin.ts <команда>
 *
 *   org list                                          — командные организации: план, места, срок, участники
 *   org plan <id|название> free|enterprise [--seats N] [--until YYYY-MM-DD]
 *                                                     — сменить план организации (срок — конец дня по Алматы)
 *   org stats <id|название>                           — участники, встречи, часы и расход за текущий месяц
 *   user list [строка]                                — пользователи: почта, имя, тариф, суперадмин
 *   user superadmin <email> on|off                    — доступ к админ-эндпоинтам (не к содержимому встреч)
 *   user tier <email> starter|pro|unlimited|free [--until YYYY-MM-DD]
 *                                                     — ручная подписка manual.* (тесты, компенсации) или её снятие
 */
import { and, asc, desc, eq, gte, ilike, lt, ne, sql } from "drizzle-orm";
import { closeDb, db } from "../src/db/client.js";
import { meetings, members, organizations, subscriptions, usageEvents, user } from "../src/db/schema/index.js";
import { grantManualSubscription, revokeManualSubscriptions } from "../src/billing/apple.js";
import { periodBounds, pickSubscription } from "../src/billing/entitlement.js";
import { ENTERPRISE_SEAT_SEC, PAID_TIERS, TIER_TITLES, type PaidTier } from "../src/billing/tiers.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const d = db();

const argv = process.argv.slice(2);
const flags = new Map<string, string>();
const args: string[] = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]!;
  if (a.startsWith("--")) flags.set(a.slice(2), argv[++i] ?? "");
  else args.push(a);
}

function fail(message: string): never {
  console.error(`✗ ${message}`);
  process.exitCode = 1;
  throw new ExitSignal();
}
class ExitSignal extends Error {}

const HELP = [
  "  org list",
  "  org plan <id|название> free|enterprise [--seats N] [--until YYYY-MM-DD]",
  "  org stats <id|название>",
  "  user list [строка]",
  "  user superadmin <email> on|off",
  "  user tier <email> starter|pro|unlimited|free [--until YYYY-MM-DD]",
].join("\n");

/** Конец дня по Алматы: план действует до последней секунды указанной даты */
function untilDate(raw: string | undefined): Date | null {
  if (!raw) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) fail(`Дата должна быть в формате YYYY-MM-DD, получено «${raw}»`);
  return new Date(`${raw}T23:59:59+05:00`);
}

const fmtDate = (v: Date | null) => (v ? v.toISOString().slice(0, 10) : "—");
/** Дата по Алматы (границы месяца хранятся в UTC) */
const fmtAlmaty = (v: Date) => new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Almaty" }).format(v);
const fmtHours = (sec: number) => `${(sec / 3600).toFixed(1)} ч`;

/** Организация по id или по названию (точное совпадение, иначе подстрока) */
async function findOrg(key: string) {
  if (UUID.test(key)) {
    const [byId] = await d.select().from(organizations).where(eq(organizations.id, key)).limit(1);
    if (byId) return byId;
  }
  const rows = await d.select().from(organizations).where(ilike(organizations.name, key)).limit(5);
  if (rows.length === 1) return rows[0]!;
  const like = await d.select().from(organizations).where(ilike(organizations.name, `%${key}%`)).limit(5);
  if (like.length === 1) return like[0]!;
  if (like.length > 1) fail(`Под «${key}» подходит несколько организаций:\n${like.map((o) => `  ${o.id}  ${o.name}`).join("\n")}`);
  return fail(`Организация «${key}» не найдена`);
}

async function findUser(email: string) {
  const [row] = await d.select().from(user).where(ilike(user.email, email.trim())).limit(1);
  if (!row) fail(`Пользователь ${email} не найден`);
  return row;
}

async function memberCount(orgId: string): Promise<number> {
  const [r] = await d.select({ n: sql<number>`count(*)::int` }).from(members).where(eq(members.organizationId, orgId));
  return r?.n ?? 0;
}

// ---------- org ----------

async function orgList() {
  const rows = await d
    .select({
      id: organizations.id,
      name: organizations.name,
      plan: organizations.plan,
      planSeats: organizations.planSeats,
      planUntil: organizations.planUntil,
      membersCount: sql<number>`(select count(*) from ${members} m where m.organization_id = ${organizations.id})::int`,
    })
    .from(organizations)
    .where(eq(organizations.kind, "team"))
    .orderBy(asc(organizations.name));
  if (!rows.length) return console.log("Командных организаций нет");
  console.log(`Командных организаций: ${rows.length}\n`);
  for (const o of rows) {
    const plan = o.plan === "enterprise" ? `enterprise${o.planSeats ? ` ×${o.planSeats}` : ""} до ${fmtDate(o.planUntil)}` : "free";
    console.log(`${o.id}  ${o.name.padEnd(28)} ${plan.padEnd(34)} участников: ${o.membersCount}`);
  }
}

async function orgPlan(key: string, plan: string) {
  if (plan !== "free" && plan !== "enterprise") fail("План может быть free или enterprise");
  const org = await findOrg(key);
  if (org.kind !== "team") fail("План меняется только у командных организаций (личное пространство живёт по подписке пользователя)");
  const seats = flags.has("seats") ? Number(flags.get("seats")) : null;
  if (flags.has("seats") && (!Number.isInteger(seats) || seats! < 1)) fail("--seats должно быть целым числом больше нуля");
  const until = untilDate(flags.get("until"));
  const patch =
    plan === "free"
      ? { plan: "free" as const, planSeats: null, planUntil: null }
      : { plan: "enterprise" as const, planSeats: seats ?? org.planSeats, planUntil: until ?? org.planUntil };
  await d.update(organizations).set(patch).where(eq(organizations.id, org.id));
  const pool = patch.plan === "enterprise" ? `, пул ${fmtHours(Math.max(1, patch.planSeats ?? 1) * ENTERPRISE_SEAT_SEC)}/мес` : "";
  console.log(`✓ ${org.name}: план ${patch.plan}${patch.planSeats ? ` на ${patch.planSeats} мест` : ""}${patch.planUntil ? ` до ${fmtDate(patch.planUntil)}` : ""}${pool}`);
}

async function orgStats(key: string) {
  const org = await findOrg(key);
  const { monthStart, monthEnd } = periodBounds(new Date(), "Asia/Almaty");
  const inMonth = and(gte(meetings.createdAt, monthStart), lt(meetings.createdAt, monthEnd));
  const [total] = await d.select({ n: sql<number>`count(*)::int` }).from(meetings).where(eq(meetings.organizationId, org.id));
  const [month] = await d
    .select({ n: sql<number>`count(*)::int`, sec: sql<number>`coalesce(sum(${meetings.durationSec}), 0)::int` })
    .from(meetings)
    .where(and(eq(meetings.organizationId, org.id), ne(meetings.status, "failed"), inMonth));
  const [cost] = await d
    .select({ usd: sql<string>`coalesce(sum(${usageEvents.costUsd}), 0)::text` })
    .from(usageEvents)
    .where(and(eq(usageEvents.organizationId, org.id), gte(usageEvents.createdAt, monthStart), lt(usageEvents.createdAt, monthEnd)));
  const byKind = await d
    .select({ kind: usageEvents.kind, usd: sql<string>`coalesce(sum(${usageEvents.costUsd}), 0)::text` })
    .from(usageEvents)
    .where(and(eq(usageEvents.organizationId, org.id), gte(usageEvents.createdAt, monthStart), lt(usageEvents.createdAt, monthEnd)))
    .groupBy(usageEvents.kind);
  const seats = org.plan === "enterprise" ? Math.max(1, org.planSeats ?? 1) : null;

  console.log(`${org.name} (${org.id})`);
  console.log(`  Пространство:  ${org.kind === "team" ? "командное" : "личное"}`);
  console.log(`  План:          ${org.plan}${seats ? ` на ${seats} мест до ${fmtDate(org.planUntil)}` : ""}`);
  console.log(`  Участников:    ${await memberCount(org.id)}`);
  console.log(`  Встреч всего:  ${total?.n ?? 0}`);
  console.log(`  За месяц:      ${month?.n ?? 0} встреч, ${fmtHours(month?.sec ?? 0)}${seats ? ` из пула ${fmtHours(seats * ENTERPRISE_SEAT_SEC)}` : ""}`);
  console.log(`  Расход:        $${Number(cost?.usd ?? 0).toFixed(2)}${byKind.length ? ` (${byKind.map((k) => `${k.kind} $${Number(k.usd).toFixed(2)}`).join(", ")})` : ""}`);
  console.log(`  Период:        ${fmtAlmaty(monthStart)} — ${fmtAlmaty(new Date(monthEnd.getTime() - 1))} (Алматы)`);
}

// ---------- user ----------

async function userList(q?: string) {
  const rows = await d
    .select({ id: user.id, email: user.email, name: user.name, isSuperadmin: user.isSuperadmin, createdAt: user.createdAt })
    .from(user)
    .where(q ? sql`${user.email} ilike ${`%${q}%`} or ${user.name} ilike ${`%${q}%`}` : undefined)
    .orderBy(desc(user.createdAt))
    .limit(100);
  if (!rows.length) return console.log("Пользователи не найдены");
  const subs = await d.select().from(subscriptions);
  const now = new Date();
  console.log(`Пользователей: ${rows.length}${rows.length === 100 ? " (показаны последние 100)" : ""}\n`);
  for (const u of rows) {
    const best = pickSubscription(subs.filter((s) => s.userId === u.id), now);
    const tier = best ? `${TIER_TITLES[best.tier]}${best.expiresAt ? ` до ${fmtDate(best.expiresAt)}` : ""}${best.environment === "Manual" ? " (вручную)" : ""}` : "Free";
    console.log(`${u.email.padEnd(34)} ${(u.name || "—").padEnd(24)} ${tier.padEnd(28)}${u.isSuperadmin ? " суперадмин" : ""}`);
  }
}

async function userSuperadmin(email: string, mode: string) {
  if (mode !== "on" && mode !== "off") fail("Укажите on или off");
  const u = await findUser(email);
  await d.update(user).set({ isSuperadmin: mode === "on" }).where(eq(user.id, u.id));
  console.log(`✓ ${u.email}: суперадмин ${mode === "on" ? "включён" : "выключен"}`);
}

async function userTier(email: string, tier: string) {
  const u = await findUser(email);
  if (tier === "free") {
    const n = await revokeManualSubscriptions(u.id);
    const [apple] = await d
      .select({ n: sql<number>`count(*)::int` })
      .from(subscriptions)
      .where(and(eq(subscriptions.userId, u.id), ne(subscriptions.environment, "Manual"), sql`${subscriptions.status} in ('active','grace')`));
    console.log(`✓ ${u.email}: снято ручных подписок — ${n}`);
    if ((apple?.n ?? 0) > 0) console.log(`  ⚠ остаётся ${apple!.n} подписка(и) App Store — она отменяется только пользователем в настройках Apple ID`);
    return;
  }
  if (!(PAID_TIERS as readonly string[]).includes(tier)) fail(`Тариф может быть ${PAID_TIERS.join(" | ")} | free`);
  const until = untilDate(flags.get("until"));
  await grantManualSubscription(u.id, tier as PaidTier, until);
  console.log(`✓ ${u.email}: ручная подписка ${TIER_TITLES[tier as PaidTier]}${until ? ` до ${fmtDate(until)}` : " бессрочно"} (product manual.${tier})`);
}

// ---------- разбор команды ----------

async function main() {
  const [group, cmd, ...rest] = args;
  if (group === "org" && cmd === "list") return orgList();
  if (group === "org" && cmd === "plan") {
    if (rest.length < 2) fail("Использование: org plan <id|название> free|enterprise [--seats N] [--until YYYY-MM-DD]");
    return orgPlan(rest[0]!, rest[1]!);
  }
  if (group === "org" && cmd === "stats") {
    if (!rest[0]) fail("Использование: org stats <id|название>");
    return orgStats(rest[0]);
  }
  if (group === "user" && cmd === "list") return userList(rest[0]);
  if (group === "user" && cmd === "superadmin") {
    if (rest.length < 2) fail("Использование: user superadmin <email> on|off");
    return userSuperadmin(rest[0]!, rest[1]!);
  }
  if (group === "user" && cmd === "tier") {
    if (rest.length < 2) fail("Использование: user tier <email> starter|pro|unlimited|free [--until YYYY-MM-DD]");
    return userTier(rest[0]!, rest[1]!);
  }
  console.log(`Команды:\n${HELP}`);
  process.exitCode = 1;
}

try {
  await main();
} catch (e) {
  if (!(e instanceof ExitSignal)) {
    console.error(`✗ ${(e as Error).message}`);
    process.exitCode = 1;
  }
} finally {
  await closeDb();
}
