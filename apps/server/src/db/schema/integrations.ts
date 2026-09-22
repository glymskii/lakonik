import { sql } from "drizzle-orm";
import { boolean, index, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { user } from "./auth.js";
import { organizations } from "./org.js";

/**
 * Подключённые аккаунты Google Meet и Zoom: штатные записи платформ попадают в приложение сами
 * (раздел 10 docs/lakonik-1.0.md). Refresh-токен хранится зашифрованным (AES-256-GCM, ключ INTEGRATIONS_KEY);
 * импорты падают в пространство organization_id, часы тратятся у владельца интеграции.
 */
export type IntegrationProvider = "google_meet" | "zoom";
export type IntegrationStatus = "active" | "error" | "revoked";

export const INTEGRATION_PROVIDERS: IntegrationProvider[] = ["google_meet", "zoom"];

export const PROVIDER_TITLES: Record<IntegrationProvider, string> = {
  google_meet: "Google Meet",
  zoom: "Zoom",
};

export const integrations = pgTable(
  "integrations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /** Пространство, куда попадают импортированные записи */
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    provider: text("provider").$type<IntegrationProvider>().notNull(),
    accountEmail: text("account_email"),
    /** Идентификатор аккаунта у провайдера (Zoom user id, Google sub) */
    accountId: text("account_id"),
    refreshTokenEnc: text("refresh_token_enc").notNull(),
    accessTokenEnc: text("access_token_enc"),
    tokenExpiresAt: timestamp("token_expires_at", { withTimezone: true }),
    scopes: text("scopes").array().notNull().default(sql`'{}'::text[]`),
    autoImport: boolean("auto_import").notNull().default(true),
    lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
    lastError: text("last_error"),
    status: text("status").$type<IntegrationStatus>().notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (t) => [unique("integrations_user_provider_uq").on(t.userId, t.provider), index("integrations_sync_idx").on(t.status, t.autoImport)],
);
