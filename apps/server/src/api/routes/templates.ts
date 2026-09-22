import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { and, asc, eq, isNull, ne, or } from "drizzle-orm";
import { db } from "../../db/client.js";
import { meetingTemplates } from "../../db/schema/index.js";
import { catalog, findGroup, type CatalogGroup } from "../../templates/catalog.js";
import { requireUser, type AppEnv } from "../middleware/auth.js";
import { withOrg } from "../middleware/org.js";
import { TemplatesResponse } from "../schemas.js";

export const templatesRoutes = new OpenAPIHono<AppEnv>();

templatesRoutes.use("*", requireUser);
templatesRoutes.use("*", withOrg);

templatesRoutes.openapi(
  createRoute({
    method: "get",
    path: "/",
    tags: ["templates"],
    summary: "Активные шаблоны встреч (последняя версия каждого кода)",
    responses: { 200: { description: "OK", content: { "application/json": { schema: TemplatesResponse } } } },
  }),
  async (c) => {
    // Системные шаблоны (запись без типа) в выборе типа не показываем
    const org = c.get("org");
    const rows = await db()
      .select()
      .from(meetingTemplates)
      .where(and(eq(meetingTemplates.isActive, true), ne(meetingTemplates.group, "system"), org ? or(isNull(meetingTemplates.organizationId), eq(meetingTemplates.organizationId, org.id)) : isNull(meetingTemplates.organizationId)))
      .orderBy(asc(meetingTemplates.sortOrder), asc(meetingTemplates.version));
    const latest = new Map<string, (typeof rows)[number]>();
    for (const r of rows) {
      const cur = latest.get(r.code);
      // приватный шаблон организации перекрывает встроенный с тем же кодом; иначе — старшая версия
      if (!cur || (!!r.organizationId && !cur.organizationId) || (!!r.organizationId === !!cur.organizationId && cur.version < r.version)) latest.set(r.code, r);
    }
    const templates = [...latest.values()]
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((t) => ({
        id: t.id,
        organizationId: t.organizationId,
        code: t.code,
        version: t.version,
        group: t.group,
        category: t.category,
        title: t.title,
        subtitle: t.subtitle,
        goal: t.goal,
        reportTitle: t.reportTitle,
        emoji: t.emoji,
        color: t.color,
        confidentiality: t.confidentiality,
        allowConfidentialityChoice: t.allowConfidentialityChoice,
        slaHours: t.slaHours,
        sendTo: t.sendTo,
        commonFields: t.commonFields,
        specificFields: t.specificFields,
        reportSections: t.reportSections,
        tips: t.tips,
        isDraft: t.isDraft,
        sortOrder: t.sortOrder,
      }));
    // Группы: встроенные + те, что встречаются у приватных шаблонов организации (из её каталога), в этом порядке
    const groups: CatalogGroup[] = [...catalog.groups];
    for (const t of templates) {
      if (groups.some((g) => g.code === t.group)) continue;
      const g = findGroup(t.group);
      if (g) groups.push(g);
    }
    return c.json({ groups, categories: catalog.categories, templates }, 200);
  },
);
