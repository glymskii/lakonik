import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { and, eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { track } from "../../analytics/amplitude.js";
import { config } from "../../config.js";
import { db } from "../../db/client.js";
import { integrations, members } from "../../db/schema/index.js";
import { PROVIDER_TITLES, type IntegrationProvider } from "../../db/schema/integrations.js";
import { decryptSecret, encryptSecret, requireIntegrationsKey } from "../../integrations/crypto.js";
import * as google from "../../integrations/google-meet.js";
import { signState, verifyState } from "../../integrations/state.js";
import * as zoom from "../../integrations/zoom.js";
import { logger } from "../../logger.js";
import { enqueueIntegrationsSync } from "../../queue/boss.js";
import { ErrorSchema, IntegrationConnectSchema, IntegrationPatchBody, IntegrationSchema } from "../schemas.js";
import { requireUser, type AppEnv } from "../middleware/auth.js";
import { requireOrg, withOrg } from "../middleware/org.js";

/**
 * Интеграции со штатными записями Google Meet и Zoom (раздел 10 docs/lakonik-1.0.md): OAuth-подключение,
 * переключатель авто-импорта, ручная синхронизация и вебхук Zoom. Callback и вебхук — без авторизации:
 * доверие даёт подписанный state и подпись Zoom.
 */
export const integrationsRoutes = new OpenAPIHono<AppEnv>();

const ProviderParam = z.object({ provider: z.enum(["google_meet", "zoom"]).openapi({ param: { name: "provider", in: "path" } }) });

/** Схема приложения: iOS ловит возврат из браузера */
const APP_CALLBACK = "lakonik://integrations/callback";

type Row = typeof integrations.$inferSelect;

const dto = (i: Row) => ({
  provider: i.provider,
  accountEmail: i.accountEmail,
  autoImport: i.autoImport,
  lastSyncAt: i.lastSyncAt ? i.lastSyncAt.toISOString() : null,
  lastError: i.lastError,
  status: i.status,
  scopes: i.scopes,
});

const isConfigured = (p: IntegrationProvider) => (p === "google_meet" ? google.googleConfigured() : zoom.zoomConfigured());

/** Провайдер без ключей в окружении — честный 503 вместо редиректа в пустоту */
function assertProviderConfigured(p: IntegrationProvider) {
  if (!isConfigured(p)) throw new HTTPException(503, { message: `Интеграция с ${PROVIDER_TITLES[p]} пока не настроена на этом сервере.` });
}

async function integrationOf(userId: string, provider: IntegrationProvider): Promise<Row> {
  const [row] = await db().select().from(integrations).where(and(eq(integrations.userId, userId), eq(integrations.provider, provider))).limit(1);
  if (!row) throw new HTTPException(404, { message: `${PROVIDER_TITLES[provider]} не подключён` });
  return row;
}

// ---------- Список ----------

integrationsRoutes.openapi(
  createRoute({
    method: "get",
    path: "/",
    tags: ["integrations"],
    summary: "Подключённые аккаунты Google Meet и Zoom",
    middleware: [requireUser, withOrg] as const,
    responses: { 200: { description: "OK", content: { "application/json": { schema: z.array(IntegrationSchema) } } } },
  }),
  async (c) => {
    const rows = await db().select().from(integrations).where(eq(integrations.userId, c.get("user").id));
    return c.json(rows.map(dto), 200);
  },
);

// ---------- Подключение ----------

integrationsRoutes.openapi(
  createRoute({
    method: "get",
    path: "/{provider}/connect",
    tags: ["integrations"],
    summary: "Ссылка авторизации провайдера (открывается в ASWebAuthenticationSession)",
    middleware: [requireUser, withOrg] as const,
    request: { params: ProviderParam },
    responses: {
      200: { description: "OK", content: { "application/json": { schema: IntegrationConnectSchema } } },
      503: { description: "Интеграция не настроена на сервере", content: { "application/json": { schema: ErrorSchema } } },
    },
  }),
  async (c) => {
    const { provider } = c.req.valid("param");
    requireIntegrationsKey();
    assertProviderConfigured(provider);
    const org = requireOrg(c.get("org"));
    // В state — пространство, куда будут падать импорты, и пользователь, чьи часы они потратят
    const state = await signState({ userId: c.get("user").id, organizationId: org.id, provider });
    return c.json({ authUrl: provider === "google_meet" ? google.googleAuthUrl(state) : zoom.zoomAuthUrl(state) }, 200);
  },
);

/** Обмен кода на токены и запись интеграции */
async function connect(provider: IntegrationProvider, state: { userId: string; organizationId: string }, code: string): Promise<Row> {
  requireIntegrationsKey();
  assertProviderConfigured(provider);
  const d = db();
  const [member] = await d
    .select({ userId: members.userId })
    .from(members)
    .where(and(eq(members.userId, state.userId), eq(members.organizationId, state.organizationId)))
    .limit(1);
  if (!member) throw new Error("Нет доступа к пространству — выберите его заново");

  let refreshToken: string | null;
  let accessToken: string;
  let expiresAt: Date | null;
  let scopes: string[];
  let email: string | null;
  let accountId: string | null;
  if (provider === "google_meet") {
    const t = await google.exchangeGoogleCode(code);
    ({ accessToken, refreshToken, expiresAt, scopes } = t);
    if (!refreshToken) throw new Error("Google не выдал постоянный доступ. Откройте myaccount.google.com → Безопасность → Сторонние приложения, удалите Lakonik и подключите заново");
    const acc = await google.googleAccount(accessToken);
    email = acc.email;
    accountId = acc.sub;
  } else {
    const t = await zoom.exchangeZoomCode(code);
    ({ accessToken, refreshToken, expiresAt, scopes } = t);
    if (!refreshToken) throw new Error("Zoom не выдал постоянный доступ — подключите заново");
    const acc = await zoom.zoomAccount(accessToken);
    email = acc.email;
    accountId = acc.id;
  }

  const values = {
    userId: state.userId,
    organizationId: state.organizationId,
    provider,
    accountEmail: email,
    accountId,
    refreshTokenEnc: encryptSecret(refreshToken),
    accessTokenEnc: encryptSecret(accessToken),
    tokenExpiresAt: expiresAt,
    scopes,
    status: "active" as const,
    lastError: null,
  };
  const [row] = await d
    .insert(integrations)
    .values(values)
    .onConflictDoUpdate({ target: [integrations.userId, integrations.provider], set: { ...values, updatedAt: new Date() } })
    .returning();
  track(state.userId, "integration_connected", { provider });
  logger.info({ userId: state.userId, provider, account: email }, "Интеграция подключена");
  return row!;
}

/** Пробелы кодируем как %20 (а не «+»): iOS разбирает ссылку через URLComponents */
const appCallback = (provider: string, params: Record<string, string>) =>
  `${APP_CALLBACK}?${Object.entries({ provider, ...params })
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join("&")}`;

/**
 * Публичный callback провайдера: проверяем state, меняем код на токены и возвращаем пользователя
 * в приложение по схеме lakonik://. Обычный роут (не OpenAPI) — тут редирект, а не JSON.
 */
integrationsRoutes.get("/:provider/callback", async (c) => {
  const provider = c.req.param("provider");
  try {
    if (provider !== "google_meet" && provider !== "zoom") throw new Error("Неизвестный провайдер");
    const error = c.req.query("error");
    if (error) throw new Error(error === "access_denied" ? "Доступ не выдан" : error);
    const code = c.req.query("code");
    const state = c.req.query("state");
    if (!code || !state) throw new Error("Провайдер не передал код авторизации");
    const payload = await verifyState(state).catch(() => {
      throw new Error("Ссылка авторизации устарела — начните подключение заново");
    });
    if (payload.provider !== provider) throw new Error("Ссылка авторизации не соответствует провайдеру");
    const row = await connect(provider, payload, code);
    // Первая синхронизация — сразу, не дожидаясь расписания
    await enqueueIntegrationsSync({ integrationId: row.id }).catch((e: Error) => logger.warn({ err: e.message }, "Не удалось поставить первую синхронизацию"));
    return c.redirect(appCallback(provider, { status: "ok" }), 302);
  } catch (e) {
    const message = e instanceof HTTPException ? e.message : (e as Error).message;
    logger.warn({ provider, err: message }, "Интеграция не подключена");
    return c.redirect(appCallback(provider, { status: "error", message }), 302);
  }
});

// ---------- Настройки, отключение, ручная синхронизация ----------

integrationsRoutes.openapi(
  createRoute({
    method: "patch",
    path: "/{provider}",
    tags: ["integrations"],
    summary: "Включить или выключить автоматический импорт записей",
    middleware: [requireUser, withOrg] as const,
    request: { params: ProviderParam, body: { content: { "application/json": { schema: IntegrationPatchBody } } } },
    responses: {
      200: { description: "OK", content: { "application/json": { schema: IntegrationSchema } } },
      404: { description: "Не подключено", content: { "application/json": { schema: ErrorSchema } } },
    },
  }),
  async (c) => {
    const { provider } = c.req.valid("param");
    const body = c.req.valid("json");
    const row = await integrationOf(c.get("user").id, provider);
    if (body.autoImport === undefined) return c.json(dto(row), 200);
    const [updated] = await db().update(integrations).set({ autoImport: body.autoImport }).where(eq(integrations.id, row.id)).returning();
    return c.json(dto(updated!), 200);
  },
);

integrationsRoutes.openapi(
  createRoute({
    method: "delete",
    path: "/{provider}",
    tags: ["integrations"],
    summary: "Отключить аккаунт (токен отзывается у провайдера)",
    middleware: [requireUser, withOrg] as const,
    request: { params: ProviderParam },
    responses: {
      200: { description: "OK", content: { "application/json": { schema: z.object({ ok: z.boolean() }) } } },
      404: { description: "Не подключено", content: { "application/json": { schema: ErrorSchema } } },
    },
  }),
  async (c) => {
    const { provider } = c.req.valid("param");
    const row = await integrationOf(c.get("user").id, provider);
    try {
      const token = row.accessTokenEnc ? decryptSecret(row.accessTokenEnc) : decryptSecret(row.refreshTokenEnc);
      if (provider === "google_meet") await google.revokeGoogleToken(token);
      else await zoom.revokeZoomToken(token);
    } catch (e) {
      logger.warn({ provider, err: (e as Error).message }, "Отзыв токена не удался — удаляем подключение");
    }
    await db().delete(integrations).where(eq(integrations.id, row.id));
    return c.json({ ok: true }, 200);
  },
);

integrationsRoutes.openapi(
  createRoute({
    method: "post",
    path: "/{provider}/sync",
    tags: ["integrations"],
    summary: "Проверить новые записи сейчас (ставит задачу в очередь)",
    middleware: [requireUser, withOrg] as const,
    request: { params: ProviderParam },
    responses: {
      200: { description: "OK", content: { "application/json": { schema: z.object({ queued: z.boolean() }) } } },
      404: { description: "Не подключено", content: { "application/json": { schema: ErrorSchema } } },
    },
  }),
  async (c) => {
    const { provider } = c.req.valid("param");
    const row = await integrationOf(c.get("user").id, provider);
    await enqueueIntegrationsSync({ integrationId: row.id });
    return c.json({ queued: true }, 200);
  },
);

// ---------- Вебхук Zoom ----------

/**
 * recording.completed и endpoint.url_validation. Проверка — подпись x-zm-signature и свежесть
 * x-zm-request-timestamp; импорт уходит в очередь, потому что ответить Zoom нужно за секунды.
 */
integrationsRoutes.post("/zoom/webhook", async (c) => {
  const secret = config().ZOOM_WEBHOOK_SECRET;
  if (!secret) return c.json({ error: "Вебхук Zoom не настроен на этом сервере", code: "503" }, 503);
  const raw = await c.req.text();
  const ok = zoom.verifyZoomWebhook({
    rawBody: raw,
    timestamp: c.req.header("x-zm-request-timestamp") ?? null,
    signature: c.req.header("x-zm-signature") ?? null,
    secret,
  });
  if (!ok) {
    logger.warn({ ts: c.req.header("x-zm-request-timestamp") ?? null }, "Zoom: подпись вебхука не сошлась");
    return c.json({ error: "Подпись не проверена", code: "401" }, 401);
  }
  let event: { event?: string; payload?: { plainToken?: string }; download_token?: string };
  try {
    event = JSON.parse(raw);
  } catch {
    return c.json({ error: "Некорректное тело запроса", code: "400" }, 400);
  }
  if (event.event === "endpoint.url_validation") return c.json(zoom.zoomUrlValidation(String(event.payload?.plainToken ?? ""), secret), 200);
  if (event.event === "recording.completed") {
    await enqueueIntegrationsSync({ zoomRecording: { payload: event.payload, downloadToken: event.download_token } });
    logger.info("Zoom: запись готова — импорт поставлен в очередь");
  }
  return c.json({ ok: true }, 200);
});
