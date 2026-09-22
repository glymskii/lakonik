import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import { auth } from "../../auth/auth.js";

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  image: string | null;
  role: string;
  agencyId: string | null;
}

import type { OrgContext } from "./org.js";

export type AppEnv = { Variables: { user: SessionUser; sessionId: string; org: OrgContext | null } };

/** Требует bearer-токен Better Auth; кладёт пользователя в контекст. */
export const requireUser = createMiddleware<AppEnv>(async (c, next) => {
  const session = await auth().api.getSession({ headers: c.req.raw.headers });
  if (!session) throw new HTTPException(401, { message: "Требуется вход" });
  const u = session.user as unknown as SessionUser & { role?: string; agencyId?: string | null };
  c.set("user", {
    id: u.id,
    email: u.email,
    name: u.name,
    image: u.image ?? null,
    role: u.role ?? "member",
    agencyId: u.agencyId ?? null,
  });
  c.set("sessionId", session.session.id);
  await next();
});
