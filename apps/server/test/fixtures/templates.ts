import type { meetingTemplates, reports } from "../../src/db/schema/index.js";
import type { RenderMeta } from "../../src/export/index.js";
import { catalog, groupOf, type Catalog, type CatalogTemplate } from "../../src/templates/catalog.js";

type TemplateRow = typeof meetingTemplates.$inferSelect;
type ReportRow = typeof reports.$inferSelect;

/** Строка meeting_templates из шаблона каталога — как её создаёт seedTemplates */
export function templateRow(t: CatalogTemplate, from: Catalog = catalog): TemplateRow {
  const group = groupOf(t.group, from);
  return {
    id: `t-${t.code}`,
    organizationId: null,
    code: t.code,
    version: 1,
    group: t.group,
    category: t.category,
    title: t.title,
    subtitle: t.subtitle,
    goal: t.goal,
    reportTitle: t.reportTitle,
    emoji: t.emojiOverride ?? group.emoji,
    color: group.color,
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
    sortOrder: 0,
    isActive: true,
    isDraft: t.isDraft,
    createdAt: new Date("2026-09-14T10:00:00Z"),
    updatedAt: new Date("2026-09-14T10:00:00Z"),
  };
}

/** Синтетический отчёт, в котором заполнены все разделы шаблона и все структурные поля */
export function syntheticReport(t: CatalogTemplate): ReportRow {
  return {
    id: `r-${t.code}`,
    meetingId: `m-${t.code}`,
    version: 1,
    templateId: `t-${t.code}`,
    templateCode: t.code,
    templateVersion: 1,
    model: "claude-opus-5",
    effort: "high",
    title: `${t.title} — тестовый отчёт`,
    summary: "Короткое резюме встречи для проверки рендера.",
    participants: [
      { name: "Айгерим", role: "руководитель проекта", company: "Наша команда", side: "ours" as const },
      { name: "Данияр", role: "директор", company: "Клиент", side: "client" as const },
    ],
    sections: t.reportSections
      .filter((s) => s.kind === "text")
      .map((s) => ({ key: s.key, heading: s.heading, content: `Содержимое раздела «${s.heading}».`, internalOnly: s.internalOnly })),
    actionItems: [{ assignee: "Айгерим", task: "Подготовить план", deadline: "20 мая", deadlineDate: null, quote: null, done: false }],
    decisions: [{ decision: "Запускаем первый этап", owner: "Данияр", deadline: "1 июня" }],
    openQuestions: ["Кто согласует бюджет"],
    clientRequests: ["Прислать смету до пятницы"],
    missingInfo: ["Бюджет не озвучен"],
    nextMeeting: { when: "25 мая", format: "Zoom", agenda: "Защита плана" },
    markdown: "",
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    costUsd: "0",
    createdBy: "pipeline",
    isCurrent: true,
    editedAt: null,
    editedBy: null,
    instructions: null,
    createdAt: new Date("2026-09-14T11:00:00Z"),
    updatedAt: new Date("2026-09-14T11:00:00Z"),
  };
}

export function renderMeta(templateTitle: string): RenderMeta {
  return {
    startedAt: new Date("2026-09-14T10:00:00Z"),
    durationSec: 3600,
    platform: "Zoom",
    templateTitle,
    confidentiality: "standard",
    includeInternal: true,
  };
}
