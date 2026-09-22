import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { logger } from "../logger.js";

/**
 * Маленький HTTP-клиент для Google и Zoom: таймауты, понятные ошибки, признак «токен истёк».
 * Тела ответов в ошибку не попадают целиком — только первые 300 символов для лога.
 */

const DEFAULT_TIMEOUT_MS = 30_000;

export class IntegrationError extends Error {
  readonly status: number;
  readonly retryable: boolean;
  /** Подключение больше не действует: нужен повторный вход пользователя */
  readonly authExpired: boolean;
  constructor(message: string, opts: { status?: number; retryable?: boolean; authExpired?: boolean } = {}) {
    super(message);
    this.name = "IntegrationError";
    this.status = opts.status ?? 0;
    this.authExpired = opts.authExpired ?? false;
    this.retryable = opts.retryable ?? (!this.authExpired && (this.status === 0 || this.status === 429 || this.status >= 500));
  }
}

export interface RequestOptions extends RequestInit {
  timeoutMs?: number;
  /** Что делаем — попадает в текст ошибки: «Google Meet: список записей» */
  what: string;
}

async function request(url: string, opts: RequestOptions): Promise<Response> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, what, ...init } = opts;
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    const err = e as Error;
    const timedOut = err.name === "TimeoutError" || err.name === "AbortError";
    throw new IntegrationError(`${what}: ${timedOut ? `нет ответа за ${Math.round(timeoutMs / 1000)} с` : err.message}`, { retryable: true });
  }
  if (!res.ok) {
    const body = (await res.text().catch(() => "")).slice(0, 300);
    const authExpired = res.status === 401 || /invalid_grant|invalid_token|expired/i.test(body);
    logger.warn({ url: url.split("?")[0], status: res.status, body }, "Интеграции: ошибка запроса");
    throw new IntegrationError(`${what}: ответ ${res.status}`, { status: res.status, authExpired });
  }
  return res;
}

export async function fetchJson<T>(url: string, opts: RequestOptions): Promise<T> {
  const res = await request(url, opts);
  try {
    return (await res.json()) as T;
  } catch {
    throw new IntegrationError(`${opts.what}: ответ не в формате JSON`, { retryable: false });
  }
}

/** POST application/x-www-form-urlencoded → JSON (обмен и обновление токенов) */
export async function postForm<T>(url: string, form: Record<string, string>, opts: Omit<RequestOptions, "body" | "method">): Promise<T> {
  return fetchJson<T>(url, {
    ...opts,
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", ...(opts.headers ?? {}) },
    body: new URLSearchParams(form).toString(),
  });
}

/** Скачивание файла потоком во временный файл (записи весят сотни мегабайт) */
export async function downloadToFile(url: string, dest: string, opts: RequestOptions): Promise<number> {
  const res = await request(url, { timeoutMs: 15 * 60_000, ...opts });
  if (!res.body) throw new IntegrationError(`${opts.what}: пустой ответ`, { retryable: true });
  await pipeline(Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(dest));
  return Number(res.headers.get("content-length") ?? 0);
}
