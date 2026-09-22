import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";
import { applyNotification, upsertSubscription, verifyNotification, verifyTransaction } from "../../billing/apple.js";
import { ensureIapAccountToken, entitlementFor } from "../../billing/entitlement.js";
import { logger } from "../../logger.js";
import { AppleNotificationBody, AppleTransactionBody, EntitlementSchema, ErrorSchema } from "../schemas.js";
import { requireUser, type AppEnv } from "../middleware/auth.js";
import { withOrg } from "../middleware/org.js";
import { orgScopeOf } from "../../billing/scope.js";

/**
 * Тариф пользователя и покупки App Store. Уровень считается по личным подпискам и плану организации
 * активного пространства (раздел 8 docs/lakonik-1.0.md). Уведомления Apple приходят без авторизации —
 * доверие к ним даёт только подпись.
 */
export const billingRoutes = new OpenAPIHono<AppEnv>();

billingRoutes.openapi(
  createRoute({
    method: "get",
    path: "/entitlement",
    tags: ["billing"],
    summary: "Текущий тариф, лимиты и расход за день/месяц",
    middleware: [requireUser, withOrg] as const,
    request: { headers: z.object({ "x-timezone": z.string().optional() }) },
    responses: { 200: { description: "OK", content: { "application/json": { schema: EntitlementSchema } } } },
  }),
  async (c) => {
    const u = c.get("user");
    const ent = await entitlementFor({ userId: u.id, org: orgScopeOf(c.get("org")), timezone: c.req.header("x-timezone") });
    return c.json(ent, 200);
  },
);

billingRoutes.openapi(
  createRoute({
    method: "post",
    path: "/apple/transactions",
    tags: ["billing"],
    summary: "Подтвердить покупку: подписанная транзакция StoreKit 2 → подписка и новый тариф",
    middleware: [requireUser, withOrg] as const,
    request: { body: { content: { "application/json": { schema: AppleTransactionBody } } } },
    responses: {
      200: { description: "OK", content: { "application/json": { schema: EntitlementSchema } } },
      400: { description: "Подпись не проверена", content: { "application/json": { schema: ErrorSchema } } },
      403: { description: "Покупка сделана под другим аккаунтом", content: { "application/json": { schema: ErrorSchema } } },
    },
  }),
  async (c) => {
    const u = c.get("user");
    const { jws } = c.req.valid("json");
    const transaction = await verifyTransaction(jws);
    // appAccountToken приложение задаёт при покупке (значение из GET /entitlement): так чужую покупку не привязать
    const expected = await ensureIapAccountToken(u.id);
    if ((transaction.appAccountToken ?? "").trim().toLowerCase() !== expected.toLowerCase()) {
      logger.warn({ userId: u.id, token: transaction.appAccountToken ?? null }, "App Store: покупка принадлежит другому аккаунту");
      throw new HTTPException(403, { message: "Эта покупка сделана под другим аккаунтом Lakonik — войдите в него или обратитесь в поддержку" });
    }
    await upsertSubscription({ userId: u.id, transaction });
    const ent = await entitlementFor({ userId: u.id, org: orgScopeOf(c.get("org")), timezone: c.req.header("x-timezone") });
    logger.info({ userId: u.id, productId: transaction.productId, tier: ent.tier }, "App Store: покупка подтверждена");
    return c.json(ent, 200);
  },
);

billingRoutes.openapi(
  createRoute({
    method: "post",
    path: "/apple/notifications",
    tags: ["billing"],
    summary: "App Store Server Notifications v2 (без авторизации, доверие по подписи)",
    request: { body: { content: { "application/json": { schema: AppleNotificationBody } } } },
    responses: {
      200: { description: "Принято", content: { "application/json": { schema: z.object({ ok: z.boolean() }) } } },
      400: { description: "Подпись не проверена", content: { "application/json": { schema: ErrorSchema } } },
    },
  }),
  async (c) => {
    const { signedPayload } = c.req.valid("json");
    const payload = await verifyNotification(signedPayload);
    try {
      const res = await applyNotification(payload);
      logger.info({ type: payload.notificationType, subtype: payload.subtype, uuid: payload.notificationUUID, handled: res.handled, reason: res.reason }, "App Store: уведомление");
    } catch (e) {
      // Подпись верна — отвечаем 200, иначе Apple будет повторять сутки; разбираем по логам и суточной сверке
      logger.error({ err: (e as Error).message, type: payload.notificationType, uuid: payload.notificationUUID }, "App Store: уведомление не применено");
    }
    return c.json({ ok: true }, 200);
  },
);
