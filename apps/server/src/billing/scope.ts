import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { organizations } from "../db/schema/index.js";
import type { OrgScope } from "./entitlement.js";

/**
 * Пространство в разрезе тарифа. В API берётся из контекста запроса (middleware withOrg),
 * в воркере — загружается по meeting.organizationId.
 */

/** Контекст запроса → OrgScope (лишние поля контекста отбрасываются) */
export function orgScopeOf(org: OrgScope | null): OrgScope | null {
  if (!org) return null;
  return { id: org.id, kind: org.kind, plan: org.plan, planSeats: org.planSeats, planUntil: org.planUntil };
}

/** Пространство по идентификатору — для пайплайна и скриптов */
export async function orgScopeById(organizationId: string | null | undefined): Promise<OrgScope | null> {
  if (!organizationId) return null;
  const [row] = await db()
    .select({ id: organizations.id, kind: organizations.kind, plan: organizations.plan, planSeats: organizations.planSeats, planUntil: organizations.planUntil })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1);
  return row ?? null;
}
