/**
 * Проверка ключа APNs: собирает JWT (ES256) из APNS_KEY_ID / APNS_TEAM_ID / APNS_PRIVATE_KEY(_FILE).
 * Если передан device token — отправляет тестовый push.
 *   pnpm --filter @lakonik/server exec tsx --env-file=.env scripts/apns-check.ts [deviceToken]
 */
import { sendApns } from "../src/push/apns.js";
import { config } from "../src/config.js";

const cfg = config();
const token = process.argv[2];
console.log(`keyId=${cfg.APNS_KEY_ID} teamId=${cfg.APNS_TEAM_ID} bundle=${cfg.APNS_BUNDLE_ID} env=${cfg.APNS_PRODUCTION ? "production" : "sandbox"} keyFile=${cfg.APNS_PRIVATE_KEY_FILE ?? "(inline)"}`);
if (!token) {
  // Без токена: проверяем только подпись — отправка на заведомо неверный токен вернёт invalid_token/error от Apple
  const r = await sendApns("00".repeat(32), { title: "ADV Meetings", body: "Проверка ключа" });
  console.log(r === "disabled" ? "✗ ключ не настроен (APNS_* пусты или файл не читается)" : `✓ JWT подписан, Apple ответил: ${r} (invalid_token — норма для тестового токена)`);
} else {
  const r = await sendApns(token, { title: "ADV Meetings", body: "Тестовое уведомление", data: { kind: "test" } });
  console.log(`результат: ${r}`);
}
