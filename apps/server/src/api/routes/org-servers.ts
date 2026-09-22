import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";
import { config } from "../../config.js";
import { logger } from "../../logger.js";
import type { AppEnv } from "../middleware/auth.js";

/**
 * Справочник корпоративных серверов: код организации → адрес её API.
 * Нужен для «корпоративного входа» в приложении: сотрудник вводит код (например ADV), приложение узнаёт адрес
 * сервера компании и дальше общается только с ним. В ответе нет персональных данных, запрос не содержит почты.
 */
export const orgServersRoutes = new OpenAPIHono<AppEnv>();

const OrgServerSchema = z.object({
  code: z.string().openapi({ example: "ADV" }),
  name: z.string().openapi({ example: "ADV Kazakhstan" }),
  apiBaseUrl: z.string().url().openapi({ example: "https://meetings.advgroup.kz" }),
  hint: z.string().nullable().openapi({ example: "Вход с корпоративной почты @advgroup.kz" }),
});

const entrySchema = z.object({ code: z.string().min(1), name: z.string().min(1), apiBaseUrl: z.string().url(), hint: z.string().optional() });

let cache: z.infer<typeof entrySchema>[] | null = null;

/** Реестр из переменной окружения ORG_SERVERS (JSON-массив). Ошибку разбора логируем и отдаём пустой список. */
function registry() {
  if (cache) return cache;
  const raw = config().ORG_SERVERS?.trim();
  if (!raw) return (cache = []);
  try {
    cache = z.array(entrySchema).parse(JSON.parse(raw));
  } catch (e) {
    logger.error({ err: (e as Error).message }, "ORG_SERVERS: не удалось разобрать реестр");
    cache = [];
  }
  return cache;
}

orgServersRoutes.openapi(
  createRoute({
    method: "get",
    path: "/{code}",
    tags: ["auth"],
    summary: "Адрес сервера организации по её коду (корпоративный вход)",
    request: { params: z.object({ code: z.string().min(2).max(32) }) },
    responses: {
      200: { description: "OK", content: { "application/json": { schema: OrgServerSchema } } },
      404: { description: "Код не найден" },
    },
  }),
  (c) => {
    const code = c.req.valid("param").code.trim().toUpperCase();
    const found = registry().find((e) => e.code.toUpperCase() === code);
    if (!found) throw new HTTPException(404, { message: "Организация с таким кодом не найдена. Проверьте код у администратора." });
    return c.json({ code: found.code.toUpperCase(), name: found.name, apiBaseUrl: found.apiBaseUrl.replace(/\/+$/, ""), hint: found.hint ?? null }, 200);
  },
);
