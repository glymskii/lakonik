import * as Sentry from "@sentry/node";
import { config } from "../config.js";
import { logger } from "../logger.js";

let enabled = false;

/** Sentry для api/worker: без SENTRY_DSN — выключен. Содержимое встреч в события не попадает (только id и шаг). */
export function initSentry(service: "api" | "worker") {
  const cfg = config();
  if (!cfg.SENTRY_DSN) return;
  Sentry.init({
    dsn: cfg.SENTRY_DSN,
    environment: cfg.NODE_ENV,
    release: process.env.RAILWAY_GIT_COMMIT_SHA ?? undefined,
    serverName: service,
    tracesSampleRate: 0,
    sendDefaultPii: false,
  });
  Sentry.setTag("service", service);
  enabled = true;
  logger.info({ service }, "Sentry включён");
}

export function captureError(err: unknown, tags: Record<string, string | undefined> = {}) {
  if (!enabled) return;
  Sentry.withScope((scope) => {
    for (const [k, v] of Object.entries(tags)) if (v) scope.setTag(k, v);
    Sentry.captureException(err);
  });
}

export async function flushSentry() {
  if (enabled) await Sentry.flush(2000).catch(() => undefined);
}
