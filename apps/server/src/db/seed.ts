import { and, eq, isNull, notInArray } from "drizzle-orm";
import { closeDb, db } from "./client.js";
import { agencies, meetingTemplates } from "./schema/index.js";
import { catalog, groupOf, legacyCatalog, type Catalog, type CatalogTemplate } from "../templates/catalog.js";
import { logger } from "../logger.js";

export const AGENCIES: { id: string; name: string }[] = [
  { id: "adv", name: "ADV" },
  { id: "havas", name: "Havas" },
  { id: "um", name: "UM" },
  { id: "mccann", name: "McCann" },
  { id: "seed", name: "SEED" },
  { id: "pixy", name: "Pixy" },
  { id: "mushrooms", name: "Mushrooms" },
  { id: "bidmedia", name: "Bid Media" },
];

export async function seedAgencies() {
  const d = db();
  for (const a of AGENCIES) {
    await d
      .insert(agencies)
      .values({ id: a.id, name: a.name })
      .onConflictDoUpdate({ target: agencies.id, set: { name: a.name } });
  }
  logger.info({ count: AGENCIES.length }, "Агентства засеяны");
}

/** Код системного шаблона «тип встречи ещё не выбран»: запись стартует без выбора типа, тип задаётся после расшифровки */
export const UNCLASSIFIED_TEMPLATE_CODE = "unclassified";

/** Системный шаблон для быстрой записи: не показывается в выборе типа, отчёт по нему не строится */
function unclassifiedTemplate() {
  return {
    organizationId: null,
    code: UNCLASSIFIED_TEMPLATE_CODE,
    version: 1,
    group: "system",
    category: "operations",
    title: "Без типа",
    subtitle: "Тип встречи выбирается после расшифровки",
    goal: "Запись без выбранного типа встречи",
    reportTitle: "Заметки встречи",
    emoji: "🎙",
    color: "gray",
    confidentiality: "standard" as const,
    allowConfidentialityChoice: true,
    slaHours: 48,
    sendTo: null,
    tone: null,
    commonFields: catalog.commonFields,
    specificFields: [],
    reportSections: [],
    rules: [],
    tips: [],
    sortOrder: 999,
    isActive: true,
    isDraft: false,
  };
}

/** Строка meeting_templates из шаблона каталога */
function templateValues(t: CatalogTemplate, from: Catalog, organizationId: string | null, sortOrder: number) {
  const group = groupOf(t.group, from);
  return {
    organizationId,
    code: t.code,
    version: 1,
    group: t.group,
    category: t.category,
    title: t.title,
    subtitle: t.subtitle,
    goal: t.goal,
    reportTitle: t.reportTitle,
    emoji: t.emojiOverride ?? group.emoji,
    color: t.emojiOverride === "🟢" ? "green" : group.color,
    confidentiality: t.confidentiality,
    allowConfidentialityChoice: t.allowConfidentialityChoice,
    slaHours: t.slaHours,
    sendTo: t.sendTo,
    tone: t.tone,
    commonFields: from.commonFields,
    specificFields: t.specificFields,
    reportSections: t.reportSections,
    rules: t.rules,
    tips: t.tips,
    sortOrder,
    isActive: true,
    isDraft: t.isDraft,
  };
}

/**
 * Upsert встроенных шаблонов версии 1 (organization_id is null) из packages/shared/templates.json + системный шаблон.
 * Версии > 1 (правки в админке) и приватные шаблоны организаций не трогаем.
 * Коды, которых больше нет в каталоге, помечаются isActive = false — строки не удаляем, на них ссылаются встречи.
 */
export async function seedTemplates() {
  const d = db();
  const rows = [unclassifiedTemplate(), ...catalog.templates.map((t, i) => templateValues(t, catalog, null, i))];
  for (const values of rows) {
    const existing = await d
      .select({ id: meetingTemplates.id })
      .from(meetingTemplates)
      .where(and(isNull(meetingTemplates.organizationId), eq(meetingTemplates.code, values.code), eq(meetingTemplates.version, 1)))
      .limit(1);
    if (existing[0]) await d.update(meetingTemplates).set(values).where(eq(meetingTemplates.id, existing[0].id));
    else await d.insert(meetingTemplates).values(values);
  }
  const retired = await d
    .update(meetingTemplates)
    .set({ isActive: false })
    .where(
      and(
        isNull(meetingTemplates.organizationId),
        eq(meetingTemplates.version, 1),
        eq(meetingTemplates.isActive, true),
        notInArray(
          meetingTemplates.code,
          rows.map((r) => r.code),
        ),
      ),
    );
  logger.info({ count: catalog.templates.length, retired: retired.rowCount ?? 0 }, "Встроенные шаблоны засеяны");
}

/**
 * Приватный каталог организации переноса (packages/shared/templates-adv.json).
 * Сеется один раз: если у организации уже есть хотя бы один свой шаблон — ничего не делаем,
 * чтобы не перетирать правки и не воскрешать удалённые.
 */
export async function seedLegacyTemplates(organizationId: string): Promise<number> {
  const d = db();
  const [existing] = await d
    .select({ id: meetingTemplates.id })
    .from(meetingTemplates)
    .where(eq(meetingTemplates.organizationId, organizationId))
    .limit(1);
  if (existing) return 0;
  await d.insert(meetingTemplates).values(legacyCatalog.templates.map((t, i) => templateValues(t, legacyCatalog, organizationId, i)));
  logger.info({ organizationId, count: legacyCatalog.templates.length }, "Приватные шаблоны организации переноса засеяны");
  return legacyCatalog.templates.length;
}

async function main() {
  await seedAgencies();
  await seedTemplates();
  await closeDb();
}

const isDirectRun = process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop() ?? "");
if (isDirectRun) {
  main().catch((e) => {
    logger.error(e, "Ошибка сида");
    process.exit(1);
  });
}
