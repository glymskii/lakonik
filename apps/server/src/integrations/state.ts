import { SignJWT, jwtVerify } from "jose";
import { config } from "../config.js";
import type { IntegrationProvider } from "../db/schema/integrations.js";

/**
 * Параметр state в OAuth — подписанный JWT (HS256, ключ BETTER_AUTH_SECRET, 10 минут):
 * провайдер возвращает его на публичный callback, и по нему мы узнаём пользователя и пространство.
 */
export interface OAuthState {
  userId: string;
  organizationId: string;
  provider: IntegrationProvider;
}

const STATE_TTL_SEC = 10 * 60;
const secretKey = (secret: string) => new TextEncoder().encode(secret);

export async function signState(state: OAuthState, secret: string = config().BETTER_AUTH_SECRET, ttlSec = STATE_TTL_SEC): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ userId: state.userId, organizationId: state.organizationId, provider: state.provider })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt(now)
    .setExpirationTime(now + ttlSec)
    .sign(secretKey(secret));
}

/** Бросает, если подпись не сошлась, срок истёк или полей нет */
export async function verifyState(token: string, secret: string = config().BETTER_AUTH_SECRET): Promise<OAuthState> {
  const { payload } = await jwtVerify(token, secretKey(secret), { algorithms: ["HS256"] });
  const { userId, organizationId, provider } = payload as Partial<OAuthState>;
  if (!userId || !organizationId || (provider !== "google_meet" && provider !== "zoom")) throw new Error("Неполный state");
  return { userId, organizationId, provider };
}
