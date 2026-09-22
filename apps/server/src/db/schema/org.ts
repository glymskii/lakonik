import { boolean, index, integer, jsonb, pgEnum, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { user } from "./auth.js";
import type { OrgSettings } from "../types.js";

/**
 * Организации и пространства. У каждого пользователя есть личное пространство (kind = personal, один участник),
 * плюс любое число командных организаций. Все данные (встречи, задачи, люди, шаблоны) принадлежат организации.
 * Таблицы добавлены поверх существующих (agencies, user.agency_id остаются до отдельной чистки) — миграция
 * только добавляет, старые клиенты продолжают работать.
 */
export const orgKind = pgEnum("org_kind", ["personal", "team"]);
export const orgPlan = pgEnum("org_plan", ["free", "enterprise"]);
export const memberRole = pgEnum("member_role", ["owner", "admin", "member"]);
export const invitationStatus = pgEnum("invitation_status", ["pending", "accepted", "revoked"]);

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull(),
};

export const organizations = pgTable(
  "organizations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    kind: orgKind("kind").notNull().default("team"),
    plan: orgPlan("plan").notNull().default("free"),
    planSeats: integer("plan_seats"),
    planUntil: timestamp("plan_until", { withTimezone: true }),
    /** Ссылка-приглашение lakonik.app/join/<token>; перевыпускается админом */
    inviteToken: text("invite_token").notNull().unique(),
    /** Сотрудники с подтверждённым доменом почты вступают сами */
    allowDomainJoin: boolean("allow_domain_join").notNull().default(false),
    settings: jsonb("settings").$type<OrgSettings>().notNull().default({}),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    ...timestamps,
  },
  (t) => [index("organizations_kind_idx").on(t.kind)],
);

export const members = pgTable(
  "members",
  {
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: memberRole("role").notNull().default("member"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [primaryKey({ columns: [t.organizationId, t.userId] }), index("members_user_idx").on(t.userId)],
);

/** Приглашения по email (ссылка-приглашение организации живёт в organizations.invite_token) */
export const invitations = pgTable(
  "invitations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: memberRole("role").notNull().default("member"),
    token: text("token").notNull().unique(),
    status: invitationStatus("status").notNull().default("pending"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    inviterId: text("inviter_id").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("invitations_org_idx").on(t.organizationId, t.status), index("invitations_email_idx").on(t.email)],
);

/** Домены почты организации: домен создателя подтверждается автоматически, остальные — админом */
export const organizationDomains = pgTable(
  "organization_domains",
  {
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    domain: text("domain").notNull(),
    verified: boolean("verified").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [primaryKey({ columns: [t.organizationId, t.domain] }), index("organization_domains_domain_idx").on(t.domain)],
);
