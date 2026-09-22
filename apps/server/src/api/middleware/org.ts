import { and, eq } from "drizzle-orm";
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import { db } from "../../db/client.js";
import { defaultOrganizationFor } from "../../db/organizations.js";
import { members, organizations } from "../../db/schema/index.js";
import type { OrgSettings } from "../../db/types.js";
import type { AppEnv } from "./auth.js";

export interface OrgContext {
  id: string;
  name: string;
  kind: "personal" | "team";
  plan: "free" | "enterprise";
  planSeats: number | null;
  planUntil: Date | null;
  role: "owner" | "admin" | "member";
  settings: OrgSettings;
  /** Пространство названо клиентом явно (заголовок X-Organization-Id), а не выбрано по умолчанию */
  explicit: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Активное пространство запроса: заголовок X-Organization-Id (новые клиенты) или пространство по умолчанию
 * (старые сборки без заголовка: организация переноса → единственная командная → личная). Проверяет членство.
 */
export const withOrg = createMiddleware<AppEnv>(async (c, next) => {
  const u = c.get("user");
  const raw = c.req.header("x-organization-id")?.trim() ?? "";
  if (raw && !UUID.test(raw)) throw new HTTPException(400, { message: "Некорректный идентификатор пространства" });
  const orgId = raw || (await defaultOrganizationFor(u.id));
  if (!orgId) {
    c.set("org", null);
    await next();
    return;
  }
  const [row] = await db()
    .select({ org: organizations, role: members.role })
    .from(members)
    .innerJoin(organizations, eq(organizations.id, members.organizationId))
    .where(and(eq(members.userId, u.id), eq(members.organizationId, orgId)))
    .limit(1);
  if (!row) throw new HTTPException(403, { message: "Нет доступа к этому пространству" });
  c.set("org", {
    id: row.org.id,
    name: row.org.name,
    kind: row.org.kind,
    plan: row.org.plan,
    planSeats: row.org.planSeats,
    planUntil: row.org.planUntil,
    role: row.role,
    settings: row.org.settings,
    explicit: !!raw,
  });
  await next();
});

export const isOrgAdmin = (org: OrgContext | null) => !!org && (org.role === "owner" || org.role === "admin");

export function requireOrg(org: OrgContext | null): OrgContext {
  if (!org) throw new HTTPException(400, { message: "Не выбрано пространство (заголовок X-Organization-Id)" });
  return org;
}

export function requireOrgAdmin(org: OrgContext | null): OrgContext {
  const o = requireOrg(org);
  if (!isOrgAdmin(o)) throw new HTTPException(403, { message: "Действие доступно администратору организации" });
  return o;
}
