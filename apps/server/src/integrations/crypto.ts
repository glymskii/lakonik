import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";
import { HTTPException } from "hono/http-exception";
import { config } from "../config.js";

/**
 * Шифрование токенов интеграций (AES-256-GCM). Ключ — INTEGRATIONS_KEY: 32 байта в hex или base64.
 * Формат значения в БД: v1.<iv>.<tag>.<шифротекст>, все части в base64url.
 */

const VERSION = "v1";
const IV_BYTES = 12;

/** Ключ 32 байта из hex (64 символа) или base64; null — задан неверно или не задан */
export function parseKey(raw: string | null | undefined): Buffer | null {
  const v = raw?.trim();
  if (!v) return null;
  const buf = /^[0-9a-fA-F]{64}$/.test(v) ? Buffer.from(v, "hex") : Buffer.from(v, "base64");
  return buf.length === 32 ? buf : null;
}

export function encryptToken(plain: string, key: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [VERSION, iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), data.toString("base64url")].join(".");
}

export function decryptToken(enc: string, key: Buffer): string {
  const [version, iv, tag, data] = enc.split(".");
  if (version !== VERSION || !iv || !tag || !data) throw new Error("Некорректный формат зашифрованного токена");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8");
}

/** Сравнение подписей без утечки времени (для вебхуков) */
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export const integrationsKey = (): Buffer | null => parseKey(config().INTEGRATIONS_KEY);

/** Ключ обязателен для подключения и использования интеграций */
export function requireIntegrationsKey(): Buffer {
  const key = integrationsKey();
  if (!key) {
    throw new HTTPException(503, { message: "Интеграции на этом сервере не настроены: нет ключа шифрования токенов (INTEGRATIONS_KEY)." });
  }
  return key;
}

export const encryptSecret = (plain: string): string => encryptToken(plain, requireIntegrationsKey());
export const decryptSecret = (enc: string): string => decryptToken(enc, requireIntegrationsKey());
