import { boolean, index, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { user } from "./auth.js";

/**
 * Подписки App Store (StoreKit 2). Источник истины — Apple: клиент присылает подписанную транзакцию
 * (`POST /api/billing/apple/transactions`), Apple присылает уведомления v2 (`/apple/notifications`),
 * раз в сутки идёт сверка через App Store Server API. Уровень пользователя считается по этой таблице
 * (см. src/billing/entitlement.ts); Enterprise живёт в организации (`organizations.plan`), не здесь.
 */
export const subscriptionTier = pgEnum("subscription_tier", ["starter", "pro", "unlimited"]);
export const subscriptionStatus = pgEnum("subscription_status", ["active", "grace", "expired", "revoked"]);

export const subscriptions = pgTable(
  "subscriptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /** lakonik.pro.monthly и т. п.; ручные подписки (тесты, компенсации) — manual.pro */
    productId: text("product_id").notNull(),
    tier: subscriptionTier("tier").notNull(),
    /** Идентификатор покупки в Apple: одна строка на подписку, продления меняют её */
    originalTransactionId: text("original_transaction_id").notNull().unique(),
    status: subscriptionStatus("status").notNull().default("active"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    autoRenew: boolean("auto_renew").notNull().default(true),
    /** Sandbox | Production | Manual (выдана администратором через scripts/admin.ts) */
    environment: text("environment").notNull().default("Production"),
    lastTransactionId: text("last_transaction_id"),
    /** Тип последнего уведомления Apple (DID_RENEW, EXPIRED, …) — для диагностики */
    lastNotificationType: text("last_notification_type"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (t) => [index("subscriptions_user_idx").on(t.userId, t.status), index("subscriptions_sync_idx").on(t.status, t.updatedAt)],
);
