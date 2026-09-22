import { and, eq, isNotNull, or } from "drizzle-orm";
import { config } from "../config.js";
import { db } from "../db/client.js";
import { account } from "../db/schema/index.js";
import { logger } from "../logger.js";
import { generateAppleClientSecret } from "./auth.js";

/**
 * Отзыв токенов Sign in with Apple при удалении аккаунта — требование ревью App Store.
 * Без ключа Apple (APPLE_TEAM_ID / APPLE_KEY_ID / APPLE_PRIVATE_KEY) шаг пропускается с записью в лог:
 * аккаунт всё равно удаляется, у пользователя остаётся «Вход с Apple» в настройках Apple ID.
 */
export async function revokeAppleTokens(userId: string): Promise<{ revoked: number; skipped: string | null }> {
  const cfg = config();
  const rows = await db()
    .select({ accessToken: account.accessToken, refreshToken: account.refreshToken })
    .from(account)
    .where(and(eq(account.userId, userId), eq(account.providerId, "apple"), or(isNotNull(account.accessToken), isNotNull(account.refreshToken))));
  if (!rows.length) return { revoked: 0, skipped: null };
  if (!cfg.APPLE_TEAM_ID || !cfg.APPLE_KEY_ID || !cfg.APPLE_PRIVATE_KEY) {
    logger.warn({ userId }, "Отзыв токена Apple пропущен: не заданы APPLE_TEAM_ID / APPLE_KEY_ID / APPLE_PRIVATE_KEY");
    return { revoked: 0, skipped: "нет ключа Apple" };
  }
  // Нативный вход с iPhone: client_id — bundle id приложения (не Service ID веб-OAuth)
  const clientId = cfg.APPLE_BUNDLE_ID;
  const clientSecret = await generateAppleClientSecret(clientId, cfg.APPLE_TEAM_ID, cfg.APPLE_KEY_ID, cfg.APPLE_PRIVATE_KEY);
  let revoked = 0;
  for (const row of rows) {
    const token = row.refreshToken ?? row.accessToken;
    if (!token) continue;
    try {
      const res = await fetch("https://appleid.apple.com/auth/revoke", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, token, token_type_hint: row.refreshToken ? "refresh_token" : "access_token" }),
      });
      if (res.ok) revoked += 1;
      else logger.warn({ userId, status: res.status, body: (await res.text()).slice(0, 200) }, "Apple не принял отзыв токена");
    } catch (e) {
      logger.warn({ userId, err: (e as Error).message }, "Отзыв токена Apple не удался");
    }
  }
  return { revoked, skipped: null };
}
