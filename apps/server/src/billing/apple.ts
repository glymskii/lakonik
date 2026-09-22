import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AppStoreServerAPIClient,
  Environment,
  SignedDataVerifier,
  Status,
  type JWSRenewalInfoDecodedPayload,
  type JWSTransactionDecodedPayload,
  type ResponseBodyV2DecodedPayload,
} from "@apple/app-store-server-library";
import { and, eq, inArray, lt, or } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { track } from "../analytics/amplitude.js";
import { config } from "../config.js";
import { db } from "../db/client.js";
import { subscriptions } from "../db/schema/index.js";
import { logger } from "../logger.js";
import { userByIapAccountToken } from "./entitlement.js";
import { periodForProduct, tierForProduct, type PaidTier } from "./tiers.js";

/**
 * App Store: проверка подписей StoreKit и уведомлений v2, запись подписок в таблицу subscriptions.
 *
 * Корневые сертификаты Apple лежат в assets/apple/*.cer (DER). Скачать заново:
 *   curl -O https://www.apple.com/certificateauthority/AppleRootCA-G3.cer
 * Без них проверка подписей невозможна — эндпоинты отвечают 503 с понятным текстом.
 */

const here = dirname(fileURLToPath(import.meta.url));
// В dev — src/billing → ../../assets; в dist — dist/billing → ../../assets (assets копируется в образ)
const CERT_DIR = resolve(here, "../../assets/apple");

export type SubStatus = (typeof subscriptions.$inferSelect)["status"];

let rootsCache: Promise<Buffer[]> | null = null;

/** DER-сертификаты корневых УЦ Apple из assets/apple */
async function appleRoots(): Promise<Buffer[]> {
  rootsCache ??= (async () => {
    const files = (await readdir(CERT_DIR).catch(() => [] as string[])).filter((f) => f.endsWith(".cer")).sort();
    return Promise.all(files.map((f) => readFile(resolve(CERT_DIR, f))));
  })();
  const roots = await rootsCache;
  if (!roots.length) {
    throw new HTTPException(503, {
      message: "Проверка покупок не настроена: нет корневых сертификатов Apple (apps/server/assets/apple/AppleRootCA-G3.cer). Повторите попытку позже.",
    });
  }
  return roots;
}

/** Окружения, подписи которых принимаем: Production всегда, Sandbox — при APPSTORE_ALLOW_SANDBOX */
export function allowedEnvironments(): Environment[] {
  const cfg = config();
  const list: Environment[] = [cfg.APPSTORE_ENVIRONMENT === "Sandbox" ? Environment.SANDBOX : Environment.PRODUCTION];
  if (cfg.APPSTORE_ALLOW_SANDBOX && !list.includes(Environment.SANDBOX)) list.push(Environment.SANDBOX);
  return list;
}

const verifiers = new Map<Environment, SignedDataVerifier>();

async function verifierFor(env: Environment): Promise<SignedDataVerifier> {
  const cached = verifiers.get(env);
  if (cached) return cached;
  const cfg = config();
  // enableOnlineChecks = false: цепочка сертификатов проверяется по корням Apple, отзыв (OCSP) не запрашиваем —
  // сеть воркера не должна ломать приём покупок.
  const v = new SignedDataVerifier(await appleRoots(), false, env, cfg.APPLE_BUNDLE_ID, env === Environment.PRODUCTION ? cfg.APPSTORE_APP_APPLE_ID : undefined);
  verifiers.set(env, v);
  return v;
}

/** Перебор разрешённых окружений: подпись Sandbox не проходит проверку Production и наоборот */
async function verifyInAnyEnvironment<T>(what: string, run: (v: SignedDataVerifier) => Promise<T>): Promise<T> {
  let last: unknown = null;
  for (const env of allowedEnvironments()) {
    try {
      return await run(await verifierFor(env));
    } catch (e) {
      if (e instanceof HTTPException) throw e;
      last = e;
    }
  }
  logger.warn({ err: (last as Error)?.message, what, environments: allowedEnvironments() }, "App Store: подпись не прошла проверку");
  throw new HTTPException(400, { message: "Подпись Apple не прошла проверку — покупка не подтверждена" });
}

export const verifyTransaction = (jws: string) => verifyInAnyEnvironment("transaction", (v) => v.verifyAndDecodeTransaction(jws));
export const verifyNotification = (signedPayload: string) => verifyInAnyEnvironment("notification", (v) => v.verifyAndDecodeNotification(signedPayload));

// ---------- Уведомления: тип → статус подписки ----------

export interface NotificationEffect {
  status?: SubStatus;
  autoRenew?: boolean;
}

/**
 * Что делать с подпиской по типу уведомления v2. Типы вне списка (PRICE_INCREASE, RENEWAL_EXTENDED и прочие)
 * только обновляют срок и признак автопродления из самой транзакции.
 */
export function effectOfNotification(type: string | undefined, subtype?: string): NotificationEffect {
  switch (type) {
    case "SUBSCRIBED":
    case "DID_RENEW":
    case "OFFER_REDEEMED":
    case "DID_CHANGE_RENEWAL_PREF":
      return { status: "active", autoRenew: true };
    case "DID_CHANGE_RENEWAL_STATUS":
      return subtype === "AUTO_RENEW_DISABLED" ? { autoRenew: false } : { autoRenew: true };
    case "DID_FAIL_TO_RENEW":
      // Подписка в льготном периоде остаётся рабочей; без него — биллинг повторяет попытки, доступа нет
      return subtype === "GRACE_PERIOD" ? { status: "grace" } : { status: "expired" };
    case "EXPIRED":
    case "GRACE_PERIOD_EXPIRED":
      return { status: "expired" };
    case "REFUND":
    case "REVOKE":
      return { status: "revoked" };
    default:
      return {};
  }
}

/** Статус подписки по ответу App Store Server API (Get All Subscription Statuses) */
export function statusFromApple(status: Status | number | undefined): SubStatus {
  switch (status) {
    case Status.ACTIVE:
      return "active";
    case Status.BILLING_GRACE_PERIOD:
      return "grace";
    case Status.REVOKED:
      return "revoked";
    case Status.BILLING_RETRY:
    case Status.EXPIRED:
      return "expired";
    default:
      return "expired";
  }
}

// ---------- Запись в БД ----------

const msDate = (ms: number | undefined): Date | null => (ms ? new Date(ms) : null);

export interface UpsertResult {
  tier: PaidTier;
  status: SubStatus;
  created: boolean;
  changed: boolean;
}

/**
 * Сохранить подписку по подтверждённой транзакции. Ключ — originalTransactionId (одна строка на подписку
 * у Apple), владелец меняется только если строки ещё нет: чужую покупку к другому аккаунту не привязать.
 */
export async function upsertSubscription(opts: {
  userId: string;
  transaction: JWSTransactionDecodedPayload;
  renewal?: JWSRenewalInfoDecodedPayload | null;
  status?: SubStatus;
  autoRenew?: boolean;
  notificationType?: string | null;
}): Promise<UpsertResult> {
  const t = opts.transaction;
  const tier = tierForProduct(t.productId);
  const originalTransactionId = t.originalTransactionId;
  if (!tier || !originalTransactionId) {
    throw new HTTPException(400, { message: "Неизвестный продукт подписки — обновите приложение" });
  }
  const now = new Date();
  const expiresAt = msDate(t.expiresDate);
  // Статус из уведомления важнее вычисленного по сроку; отозванную покупку срок не воскрешает
  const revoked = !!t.revocationDate;
  const status: SubStatus = revoked ? "revoked" : (opts.status ?? (expiresAt && expiresAt.getTime() <= now.getTime() ? "expired" : "active"));
  const autoRenew = opts.autoRenew ?? (opts.renewal?.autoRenewStatus !== undefined ? opts.renewal.autoRenewStatus === 1 : status === "active");

  const d = db();
  const [existing] = await d.select().from(subscriptions).where(eq(subscriptions.originalTransactionId, originalTransactionId)).limit(1);
  const values = {
    userId: existing?.userId ?? opts.userId,
    productId: t.productId!,
    tier,
    originalTransactionId,
    status,
    expiresAt,
    autoRenew,
    environment: typeof t.environment === "string" ? t.environment : "Production",
    lastTransactionId: t.transactionId ?? null,
    lastNotificationType: opts.notificationType ?? existing?.lastNotificationType ?? null,
  };
  if (!existing) {
    await d.insert(subscriptions).values(values).onConflictDoUpdate({ target: subscriptions.originalTransactionId, set: { ...values, updatedAt: now } });
    track(values.userId, "subscription_started", { tier, period: periodForProduct(t.productId) ?? "unknown", environment: values.environment });
    return { tier, status, created: true, changed: true };
  }
  const changed = existing.status !== status || existing.expiresAt?.getTime() !== expiresAt?.getTime() || existing.autoRenew !== autoRenew || existing.productId !== values.productId;
  // updatedAt обновляем всегда: по нему идёт суточная сверка «подписки без уведомлений»
  await d.update(subscriptions).set({ ...values, updatedAt: now }).where(eq(subscriptions.id, existing.id));
  if (changed) {
    const period = periodForProduct(t.productId) ?? "unknown";
    if (status === "active" && existing.expiresAt && expiresAt && expiresAt > existing.expiresAt) track(values.userId, "subscription_renewed", { tier, period });
    if ((status === "expired" || status === "revoked") && existing.status !== status) track(values.userId, "subscription_cancelled", { tier, period, status });
    else if (existing.autoRenew && !autoRenew) track(values.userId, "subscription_cancelled", { tier, period, status: "auto_renew_off" });
  }
  return { tier, status, created: false, changed };
}

/**
 * Обработать уведомление App Store Server Notifications v2. Владелец берётся из appAccountToken
 * транзакции (задаётся приложением при покупке) или из уже известной подписки.
 */
export async function applyNotification(payload: ResponseBodyV2DecodedPayload): Promise<{ handled: boolean; reason?: string }> {
  const type = typeof payload.notificationType === "string" ? payload.notificationType : undefined;
  const subtype = typeof payload.subtype === "string" ? payload.subtype : undefined;
  const signedTransaction = payload.data?.signedTransactionInfo;
  if (!signedTransaction) return { handled: false, reason: `без транзакции (${type ?? "?"})` };

  const transaction = await verifyTransaction(signedTransaction);
  const renewal = payload.data?.signedRenewalInfo ? await verifyRenewal(payload.data.signedRenewalInfo) : null;
  const original = transaction.originalTransactionId;
  const [known] = original ? await db().select({ userId: subscriptions.userId }).from(subscriptions).where(eq(subscriptions.originalTransactionId, original)).limit(1) : [];
  const userId = known?.userId ?? (await userByIapAccountToken(transaction.appAccountToken));
  if (!userId) return { handled: false, reason: "неизвестный пользователь (appAccountToken не найден)" };

  const effect = effectOfNotification(type, subtype);
  await upsertSubscription({ userId, transaction, renewal, status: effect.status, autoRenew: effect.autoRenew, notificationType: type ?? null });
  return { handled: true };
}

const verifyRenewal = (jws: string) => verifyInAnyEnvironment("renewalInfo", (v) => v.verifyAndDecodeRenewalInfo(jws));

// ---------- Суточная сверка через App Store Server API ----------

/** Клиент App Store Server API; null — ключи не заданы (сверка пропускается) */
function apiClient(): AppStoreServerAPIClient | null {
  const cfg = config();
  if (!cfg.APPSTORE_KEY_ID || !cfg.APPSTORE_ISSUER_ID || !cfg.APPSTORE_PRIVATE_KEY) return null;
  const env = cfg.APPSTORE_ENVIRONMENT === "Sandbox" ? Environment.SANDBOX : Environment.PRODUCTION;
  return new AppStoreServerAPIClient(cfg.APPSTORE_PRIVATE_KEY.replace(/\\n/g, "\n"), cfg.APPSTORE_KEY_ID, cfg.APPSTORE_ISSUER_ID, cfg.APPLE_BUNDLE_ID, env);
}

/**
 * Сверка подписок, по которым больше суток не приходило уведомлений (пропавший вебхук, отмена в песочнице).
 * Без ключей App Store Server API пропускается с записью в лог.
 */
export async function syncStaleSubscriptions(olderThanHours = 24, limit = 200): Promise<{ checked: number; updated: number }> {
  const client = apiClient();
  if (!client) {
    logger.info("App Store: сверка подписок пропущена — не заданы APPSTORE_KEY_ID / APPSTORE_ISSUER_ID / APPSTORE_PRIVATE_KEY");
    return { checked: 0, updated: 0 };
  }
  const since = new Date(Date.now() - olderThanHours * 3600_000);
  const rows = await db()
    .select({ id: subscriptions.id, userId: subscriptions.userId, originalTransactionId: subscriptions.originalTransactionId })
    .from(subscriptions)
    .where(and(inArray(subscriptions.status, ["active", "grace"]), lt(subscriptions.updatedAt, since), or(eq(subscriptions.environment, "Sandbox"), eq(subscriptions.environment, "Production"))))
    .limit(limit);
  let updated = 0;
  for (const row of rows) {
    try {
      const res = await client.getAllSubscriptionStatuses(row.originalTransactionId);
      for (const group of res.data ?? []) {
        for (const item of group.lastTransactions ?? []) {
          if (item.originalTransactionId !== row.originalTransactionId || !item.signedTransactionInfo) continue;
          const transaction = await verifyTransaction(item.signedTransactionInfo);
          const renewal = item.signedRenewalInfo ? await verifyRenewal(item.signedRenewalInfo) : null;
          const r = await upsertSubscription({ userId: row.userId, transaction, renewal, status: statusFromApple(item.status), notificationType: "SYNC" });
          if (r.changed) updated += 1;
        }
      }
    } catch (e) {
      logger.warn({ err: (e as Error).message, originalTransactionId: row.originalTransactionId }, "App Store: сверка подписки не удалась");
    }
  }
  if (rows.length) logger.info({ checked: rows.length, updated }, "App Store: сверка подписок выполнена");
  return { checked: rows.length, updated };
}

/** Ручная подписка (тесты, компенсации) — выдаётся администратором через scripts/admin.ts */
export async function grantManualSubscription(userId: string, tier: PaidTier, until: Date | null) {
  const originalTransactionId = `manual:${userId}:${tier}`;
  const values = {
    userId,
    productId: `manual.${tier}`,
    tier,
    originalTransactionId,
    status: "active" as const,
    expiresAt: until,
    autoRenew: false,
    environment: "Manual",
    lastTransactionId: null,
    lastNotificationType: "MANUAL",
  };
  await db()
    .insert(subscriptions)
    .values(values)
    .onConflictDoUpdate({ target: subscriptions.originalTransactionId, set: { ...values, updatedAt: new Date() } });
  track(userId, "subscription_started", { tier, period: "manual" });
}

/** Снять ручные подписки пользователя (переводом в expired — история покупок не теряется) */
export async function revokeManualSubscriptions(userId: string): Promise<number> {
  const res = await db()
    .update(subscriptions)
    .set({ status: "expired", autoRenew: false, expiresAt: new Date(), updatedAt: new Date() })
    .where(and(eq(subscriptions.userId, userId), eq(subscriptions.environment, "Manual")));
  return res.rowCount ?? 0;
}
