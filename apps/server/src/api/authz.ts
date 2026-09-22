import { and, eq, gt, inArray, isNull, notInArray, or } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { db } from "../db/client.js";
import { meetings, members, shares } from "../db/schema/index.js";
import type { SessionUser } from "./middleware/auth.js";
import type { OrgContext } from "./middleware/org.js";

export type Meeting = typeof meetings.$inferSelect;

export interface Access {
  meeting: Meeting;
  isOwner: boolean;
  /** report | report_transcript | full (владелец / админ) */
  scope: "report" | "report_transcript" | "full";
}

/**
 * Правила доступа к содержимому встречи (транскрипт, отчёт, задачи):
 * - владелец — полный доступ;
 * - получатель share — по scope (report / report_transcript).
 * Роли agency_admin / holding_admin НЕ дают неявного доступа к чужим встречам: содержимое встреч видно только
 * тем, с кем ими явно поделились. Роли остаются для административных функций (шаблоны, статистика).
 */
export async function loadMeetingWithAccess(meetingId: string, user: SessionUser): Promise<Access> {
  const [m] = await db().select().from(meetings).where(eq(meetings.id, meetingId)).limit(1);
  if (!m) throw new HTTPException(404, { message: "Встреча не найдена" });
  if (m.ownerId === user.id) return { meeting: m, isOwner: true, scope: "full" };

  const [sh] = await db()
    .select()
    .from(shares)
    .where(
      and(
        eq(shares.meetingId, meetingId),
        or(eq(shares.recipientUserId, user.id), eq(shares.recipientEmail, user.email.toLowerCase())),
        or(isNull(shares.expiresAt), gt(shares.expiresAt, new Date())),
      ),
    )
    .limit(1);
  if (sh) return { meeting: m, isOwner: false, scope: sh.scope };
  throw new HTTPException(404, { message: "Встреча не найдена" });
}

/**
 * Встречи в списке пространства: свои — только из текущего пространства; расшаренные со мной — из пространства встречи,
 * а из организаций, где я не состою, — в личном пространстве. Без пространства (нет членств) — как раньше: свои + расшаренные.
 */
export function accessibleMeetingsWhere(u: Pick<SessionUser, "id" | "email">, org: OrgContext | null) {
  const d = db();
  const sharedIds = d
    .select({ id: shares.meetingId })
    .from(shares)
    .where(and(or(eq(shares.recipientUserId, u.id), eq(shares.recipientEmail, u.email.toLowerCase())), or(isNull(shares.expiresAt), gt(shares.expiresAt, new Date()))));
  const own = eq(meetings.ownerId, u.id);
  const shared = inArray(meetings.id, sharedIds);
  if (!org) return or(own, shared);
  const inOrg = eq(meetings.organizationId, org.id);
  if (org.kind !== "personal") return or(and(own, inOrg), and(shared, inOrg));
  const myOrgIds = d.select({ id: members.organizationId }).from(members).where(eq(members.userId, u.id));
  const foreign = or(isNull(meetings.organizationId), notInArray(meetings.organizationId, myOrgIds));
  return or(and(own, inOrg), and(shared, or(inOrg, foreign)));
}

export function requireOwner(a: Access) {
  if (!a.isOwner) throw new HTTPException(403, { message: "Действие доступно только владельцу встречи" });
}
