import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { getDeadlineSettings, saveDeadlineSettings } from "../../tasks/service.js";
import { requireUser, type AppEnv } from "../middleware/auth.js";
import { requireOrgAdmin, withOrg } from "../middleware/org.js";
import { DeadlineSettingsPatch, DeadlineSettingsSchema } from "../schemas.js";

export const settingsRoutes = new OpenAPIHono<AppEnv>();
settingsRoutes.use("*", requireUser);
settingsRoutes.use("*", withOrg);

settingsRoutes.openapi(
  createRoute({
    method: "get",
    path: "/deadlines",
    tags: ["settings"],
    summary: "Настройки сроков текущего пространства",
    responses: { 200: { description: "OK", content: { "application/json": { schema: DeadlineSettingsSchema } } } },
  }),
  async (c) => c.json(await getDeadlineSettings(c.get("org")?.id), 200),
);

settingsRoutes.openapi(
  createRoute({
    method: "put",
    path: "/deadlines",
    tags: ["settings"],
    summary: "Изменить настройки сроков",
    request: { body: { content: { "application/json": { schema: DeadlineSettingsPatch } } } },
    responses: { 200: { description: "OK", content: { "application/json": { schema: DeadlineSettingsSchema } } } },
  }),
  async (c) => {
    const u = c.get("user");
    const body = c.req.valid("json");
    const org = c.get("org");
    if (org) requireOrgAdmin(org);
    return c.json(await saveDeadlineSettings(body, u.id, org?.id), 200);
  },
);
