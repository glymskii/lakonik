import { randomUUID } from "node:crypto";
import { and, eq, gte, isNull, lt, ne, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { meetings, subscriptions, user } from "../db/schema/index.js";
import { limitsFor, TIER_RANK, type PaidTier, type Tier, type TierLimits } from "./tiers.js";

/**
 * Уровень пользователя (entitlement) и расход за период.
 *
 * Правила:
 *  - личное пространство — по личной подписке: максимальный активный уровень среди subscriptions
 *    (status active|grace и expires_at в будущем), иначе free;
 *  - организация с планом enterprise (не истёк) — уровень enterprise для всех участников, часы идут
 *    в общий пул организации (20 ч × мест), а не в личный счётчик;
 *  - границы дня и месяца — по часовому поясу клиента (заголовок X-Timezone), по умолчанию Asia/Almaty.
 */

export const DEFAULT_TIMEZONE = "Asia/Almaty";

/** Организация в разрезе тарифа: то, что нужно от контекста запроса или из БД */
export interface OrgScope {
  id: string;
  kind: "personal" | "team";
  plan: "free" | "enterprise";
  planSeats: number | null;
  planUntil: Date | null;
}

export interface SubscriptionInfo {
  productId: string;
  tier: PaidTier;
  expiresAt: string | null;
  autoRenew: boolean;
  status: "active" | "grace" | "expired" | "revoked";
  environment: string;
}

export interface Entitlement {
  tier: Tier;
  source: "free" | "subscription" | "enterprise";
  limits: TierLimits;
  usage: { monthlySec: number; dailyCount: number; monthResetsAt: string; dayResetsAt: string };
  subscription: SubscriptionInfo | null;
  /** UUID для StoreKit: приложение передаёт его в purchase(options: [.appAccountToken(…)]) */
  appAccountToken: string;
}

// ---------- Границы дня и месяца в часовом поясе клиента ----------

/** Корректен ли идентификатор пояса IANA (Intl бросает RangeError на мусоре) */
export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Пояс запроса: заголовок X-Timezone, иначе Asia/Almaty */
export function resolveTimezone(raw: string | null | undefined): string {
  const tz = raw?.trim();
  if (!tz || tz.length > 64 || !isValidTimezone(tz)) return DEFAULT_TIMEZONE;
  return tz;
}

const PARTS = { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" } as const;

/** Локальные дата и время момента `at` в поясе `tz` */
function localParts(at: Date, tz: string) {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour12: false, ...PARTS });
  const p: Record<string, number> = {};
  for (const { type, value } of f.formatToParts(at)) if (type !== "literal") p[type] = Number(value);
  // hourCycle h23 отдаёт 24 для полуночи в некоторых версиях ICU
  return { y: p.year!, m: p.month!, d: p.day!, hh: (p.hour ?? 0) % 24, mm: p.minute!, ss: p.second! };
}

/** Смещение пояса в момент `at`, миллисекунды */
function offsetMs(at: Date, tz: string): number {
  const { y, m, d, hh, mm, ss } = localParts(at, tz);
  return Date.UTC(y, m - 1, d, hh, mm, ss) - (at.getTime() - at.getUTCMilliseconds());
}

/**
 * Момент UTC, соответствующий локальному времени в поясе. Значения вне диапазона нормализуются
 * (день 32 → следующий месяц, месяц 13 → следующий год). Второй проход уточняет результат на переходах
 * летнего времени.
 */
export function zonedTimeToUtc(tz: string, y: number, m: number, d: number, hh = 0, mm = 0, ss = 0): Date {
  const wall = Date.UTC(y, m - 1, d, hh, mm, ss);
  let ts = wall - offsetMs(new Date(wall), tz);
  ts = wall - offsetMs(new Date(ts), tz);
  return new Date(ts);
}

export interface Period {
  dayStart: Date;
  dayEnd: Date;
  monthStart: Date;
  monthEnd: Date;
}

/** Границы текущих календарных суток и месяца в поясе клиента */
export function periodBounds(now: Date, tz: string): Period {
  const { y, m, d } = localParts(now, tz);
  return {
    dayStart: zonedTimeToUtc(tz, y, m, d),
    dayEnd: zonedTimeToUtc(tz, y, m, d + 1),
    monthStart: zonedTimeToUtc(tz, y, m, 1),
    monthEnd: zonedTimeToUtc(tz, y, m + 1, 1),
  };
}

// ---------- Выбор подписки и уровня ----------

type SubRow = Pick<typeof subscriptions.$inferSelect, "productId" | "tier" | "status" | "expiresAt" | "autoRenew" | "environment">;

/** Подписка действует, если статус active|grace и срок не истёк (без срока — бессрочная ручная) */
export function isSubscriptionActive(s: Pick<SubRow, "status" | "expiresAt">, now: Date): boolean {
  if (s.status !== "active" && s.status !== "grace") return false;
  return !s.expiresAt || s.expiresAt.getTime() > now.getTime();
}

/** Максимальный активный уровень среди подписок пользователя; null — только free */
export function pickSubscription<T extends SubRow>(rows: T[], now: Date): T | null {
  let best: T | null = null;
  for (const s of rows) {
    if (!isSubscriptionActive(s, now)) continue;
    if (!best || TIER_RANK[s.tier] > TIER_RANK[best.tier]) best = s;
  }
  return best;
}

/** Действует ли план enterprise организации на момент `now` */
export function isEnterpriseActive(org: OrgScope | null, now: Date): boolean {
  if (!org || org.plan !== "enterprise") return false;
  return !org.planUntil || org.planUntil.getTime() > now.getTime();
}

/** Уровень и его источник: организация важнее личной подписки */
export function resolveTier(sub: SubRow | null, org: OrgScope | null, now: Date): { tier: Tier; source: Entitlement["source"] } {
  if (isEnterpriseActive(org, now)) return { tier: "enterprise", source: "enterprise" };
  if (sub && isSubscriptionActive(sub, now)) return { tier: sub.tier, source: "subscription" };
  return { tier: "free", source: "free" };
}

const subscriptionInfo = (s: SubRow): SubscriptionInfo => ({
  productId: s.productId,
  tier: s.tier,
  expiresAt: s.expiresAt ? s.expiresAt.toISOString() : null,
  autoRenew: s.autoRenew,
  status: s.status,
  environment: s.environment,
});

// ---------- appAccountToken для StoreKit ----------

/**
 * UUID, который приложение передаёт в покупку (`appAccountToken`): Apple принимает только UUID, а id
 * пользователя Better Auth им не является. Выдаётся один раз и больше не меняется; при гонке параллельных
 * запросов остаётся тот, кто успел записать первым.
 */
export async function ensureIapAccountToken(userId: string): Promise<string> {
  const d = db();
  const [row] = await d.select({ token: user.iapAccountToken }).from(user).where(eq(user.id, userId)).limit(1);
  if (row?.token) return row.token;
  const [claimed] = await d
    .update(user)
    .set({ iapAccountToken: randomUUID() })
    .where(and(eq(user.id, userId), isNull(user.iapAccountToken)))
    .returning({ token: user.iapAccountToken });
  if (claimed?.token) return claimed.token;
  const [again] = await d.select({ token: user.iapAccountToken }).from(user).where(eq(user.id, userId)).limit(1);
  if (!again?.token) throw new Error(`Не удалось выдать appAccountToken пользователю ${userId}`);
  return again.token;
}

/** Пользователь по appAccountToken из транзакции Apple (регистр не важен) */
export async function userByIapAccountToken(token: string | null | undefined): Promise<string | null> {
  const value = token?.trim().toLowerCase();
  if (!value) return null;
  const [row] = await db().select({ id: user.id }).from(user).where(sql`lower(${user.iapAccountToken}::text) = ${value}`).limit(1);
  return row?.id ?? null;
}

// ---------- Загрузка из БД ----------

async function activeSubscriptionOf(userId: string, now: Date): Promise<SubRow | null> {
  const rows = await db()
    .select({ productId: subscriptions.productId, tier: subscriptions.tier, status: subscriptions.status, expiresAt: subscriptions.expiresAt, autoRenew: subscriptions.autoRenew, environment: subscriptions.environment })
    .from(subscriptions)
    .where(eq(subscriptions.userId, userId));
  return pickSubscription(rows, now);
}

/** Уровень и лимиты без обращения к счётчикам расхода — для пайплайна (выбор модели отчёта) */
export async function tierOf(userId: string, org: OrgScope | null, now = new Date()): Promise<{ tier: Tier; source: Entitlement["source"]; limits: TierLimits }> {
  const sub = isEnterpriseActive(org, now) ? null : await activeSubscriptionOf(userId, now);
  const { tier, source } = resolveTier(sub, org, now);
  return { tier, source, limits: limitsFor(tier, org?.planSeats) };
}

/** Записано секунд за месяц: по пулу организации (enterprise) или по встречам владельца */
async function monthlySecOf(scope: { userId: string } | { organizationId: string }, period: Period): Promise<number> {
  const where = and(
    "userId" in scope ? eq(meetings.ownerId, scope.userId) : eq(meetings.organizationId, scope.organizationId),
    ne(meetings.status, "failed"),
    gte(meetings.createdAt, period.monthStart),
    lt(meetings.createdAt, period.monthEnd),
  );
  const [row] = await db().select({ sec: sql<number>`coalesce(sum(${meetings.durationSec}), 0)::int` }).from(meetings).where(where);
  return row?.sec ?? 0;
}

/** Сколько встреч владелец создал за календарные сутки (неудачные не считаются) */
async function dailyCountOf(userId: string, period: Period): Promise<number> {
  const [row] = await db()
    .select({ n: sql<number>`count(*)::int` })
    .from(meetings)
    .where(and(eq(meetings.ownerId, userId), ne(meetings.status, "failed"), gte(meetings.createdAt, period.dayStart), lt(meetings.createdAt, period.dayEnd)));
  return row?.n ?? 0;
}

/** Полный entitlement с расходом за текущие сутки и месяц */
export async function entitlementFor(opts: { userId: string; org: OrgScope | null; timezone?: string | null; now?: Date }): Promise<Entitlement> {
  const now = opts.now ?? new Date();
  const tz = resolveTimezone(opts.timezone);
  const period = periodBounds(now, tz);
  const sub = await activeSubscriptionOf(opts.userId, now);
  const { tier, source } = resolveTier(sub, opts.org, now);
  const limits = limitsFor(tier, opts.org?.planSeats);
  const pool = source === "enterprise" && opts.org ? { organizationId: opts.org.id } : { userId: opts.userId };
  const [monthlySec, dailyCount, appAccountToken] = await Promise.all([monthlySecOf(pool, period), dailyCountOf(opts.userId, period), ensureIapAccountToken(opts.userId)]);
  return {
    tier,
    source,
    limits,
    usage: { monthlySec, dailyCount, monthResetsAt: period.monthEnd.toISOString(), dayResetsAt: period.dayEnd.toISOString() },
    subscription: sub ? subscriptionInfo(sub) : null,
    appAccountToken,
  };
}
