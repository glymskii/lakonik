import { OpenAPIHono } from "@hono/zod-openapi";
import { captureError } from "../observability/sentry.js";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { requestId } from "hono/request-id";
import { auth } from "../auth/auth.js";
import { config } from "../config.js";
import { logger } from "../logger.js";
import type { AppEnv } from "./middleware/auth.js";
import { meetingsRoutes } from "./routes/meetings.js";
import { meRoutes, usersRoutes } from "./routes/me.js";
import { templatesRoutes } from "./routes/templates.js";
import { meetingTasksRoutes, tasksRoutes } from "./routes/tasks.js";
import { peopleRoutes } from "./routes/people.js";
import { settingsRoutes } from "./routes/settings.js";

export function createApp() {
  const cfg = config();
  const app = new OpenAPIHono<AppEnv>({
    defaultHook: (result, c) => {
      if (!result.success) {
        return c.json({ error: "Некорректный запрос", code: "VALIDATION", issues: result.error.issues }, 422);
      }
    },
  });

  app.use("*", requestId());
  app.use("*", async (c, next) => {
    const started = Date.now();
    await next();
    if (c.req.path !== "/health") {
      const user = (c as unknown as { get(k: "user"): { id?: string; email?: string } | undefined }).get("user");
      logger.info({ method: c.req.method, path: c.req.path, status: c.res.status, ms: Date.now() - started, reqId: c.get("requestId"), user: user?.email ?? undefined }, "http");
    }
  });
  app.use("/api/*", cors({ origin: [cfg.BASE_URL], credentials: true, allowHeaders: ["Authorization", "Content-Type"], exposeHeaders: ["set-auth-token"] }));

  app.get("/health", (c) => c.json({ ok: true, service: "api", time: new Date().toISOString() }));

  // Better Auth: /api/auth/*
  app.on(["GET", "POST"], "/api/auth/*", (c) => auth().handler(c.req.raw));

  app.route("/api/templates", templatesRoutes);
  app.route("/api/meetings", meetingTasksRoutes);
  app.route("/api/meetings", meetingsRoutes);
  app.route("/api/tasks", tasksRoutes);
  app.route("/api/people", peopleRoutes);
  app.route("/api/settings", settingsRoutes);
  app.route("/api/me", meRoutes);
  app.route("/api/users", usersRoutes);

  app.doc("/api/openapi.json", {
    openapi: "3.1.0",
    info: { title: "Lakonik API", version: "0.1.0", description: "Запись встреч → транскрибация → контакт-репорт по шаблону ADV" },
    servers: [{ url: cfg.BASE_URL }],
  });
  app.openAPIRegistry.registerComponent("securitySchemes", "bearerAuth", { type: "http", scheme: "bearer" });

  app.notFound((c) => c.json({ error: "Не найдено", code: "NOT_FOUND" }, 404));
  app.onError((err, c) => {
    if (err instanceof HTTPException) {
      return c.json({ error: err.message, code: String(err.status) }, err.status);
    }
    logger.error({ err, path: c.req.path, reqId: c.get("requestId") }, "Unhandled error");
    captureError(err, { path: c.req.path, reqId: c.get("requestId") });
    return c.json({ error: "Внутренняя ошибка сервера", code: "INTERNAL" }, 500);
  });

  return app;
}

export type App = ReturnType<typeof createApp>;
