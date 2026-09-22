import { describe, expect, it } from "vitest";
import { renderMarkdown, formatDuration } from "../src/export/markdown.js";
import { buildSystemPrompt } from "../src/llm/prompt.js";
import { catalog } from "../src/templates/catalog.js";

const tpl = catalog.templates.find((t) => t.code === "client_brief")!;
const template = {
  id: "t1",
  code: tpl.code,
  version: 1,
  organizationId: null,
  group: tpl.group,
  category: tpl.category,
  title: tpl.title,
  subtitle: tpl.subtitle,
  goal: tpl.goal,
  reportTitle: tpl.reportTitle,
  emoji: "🔵",
  color: "blue",
  confidentiality: "standard" as const,
  allowConfidentialityChoice: false,
  slaHours: 24,
  sendTo: tpl.sendTo,
  tone: tpl.tone,
  commonFields: catalog.commonFields,
  specificFields: tpl.specificFields,
  reportSections: tpl.reportSections,
  rules: tpl.rules,
  tips: tpl.tips,
  sortOrder: 0,
  isActive: true,
  isDraft: false,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const report = {
  id: "r1",
  meetingId: "m1",
  version: 1,
  organizationId: null,
  templateId: "t1",
  templateCode: "client_brief",
  templateVersion: 1,
  model: "claude-opus-5",
  effort: "high",
  title: "Nomad Summer — бриф",
  summary: "Клиент передал бриф на летнюю кампанию.",
  participants: [{ name: "Айгерим", role: "медиапланер", company: "ADV", side: "ours" as const }],
  sections: [
    { key: "brief", heading: "БРИФ", content: "- Продукт: **Nomad**\n- Бюджет: 40 млн ₸" },
    { key: "internal_comments", heading: "ВНУТРЕННИЕ КОММЕНТАРИИ", content: "Клиент торопится", internalOnly: true },
  ],
  actionItems: [{ assignee: "Айгерим", task: "Медиаплан", deadline: "20 мая", quote: null, done: false }],
  decisions: [],
  openQuestions: ["Tone of voice"],
  clientRequests: [],
  missingInfo: ["Бюджет продакшна"],
  nextMeeting: { when: "25 мая", format: "Zoom", agenda: "Защита медиаплана" },
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
  createdAt: new Date(),
  updatedAt: new Date(),
};

const meta = { startedAt: new Date("2026-09-14T10:00:00Z"), durationSec: 3600, platform: "Zoom", templateTitle: "Брифинг от клиента", confidentiality: "standard" as const, includeInternal: true };

describe("renderMarkdown", () => {
  it("рендерит разделы в порядке шаблона с таблицей action plan", () => {
    const md = renderMarkdown(template, report, meta);
    expect(md).toContain("# Контакт-репорт: Брифинг от клиента");
    expect(md.indexOf("## 1. РЕЗЮМЕ ЗАДАЧИ")).toBeLessThan(md.indexOf("## 3. БРИФ"));
    expect(md).toContain("| Айгерим | Медиаплан | 20 мая |");
    expect(md).toContain("ВНУТРЕННИЕ КОММЕНТАРИИ 🔒");
    expect(md).toContain("Длительность: 1 ч");
    expect(md).toContain("- Бюджет продакшна");
  });
  it("скрывает внутренние блоки для внешней версии", () => {
    const md = renderMarkdown(template, report, { ...meta, includeInternal: false });
    expect(md).not.toContain("ВНУТРЕННИЕ КОММЕНТАРИИ");
    expect(md).toContain("## 5. ACTION PLAN");
  });
});

describe("formatDuration", () => {
  it("форматирует", () => {
    expect(formatDuration(7)).toBe("меньше минуты");
    expect(formatDuration(600)).toBe("10 мин");
    expect(formatDuration(5400)).toBe("1 ч 30 мин");
    expect(formatDuration(null)).toBeNull();
  });
});

describe("buildSystemPrompt", () => {
  it("содержит структуру и правила шаблона, стабильная часть не зависит от шаблона", () => {
    const a = buildSystemPrompt(template);
    expect(a.stable).toContain("ОБЩИЕ ПРАВИЛА");
    expect(a.template).toContain("ВОПРОСЫ К КЛИЕНТУ [key=client_questions; заполняется через поле openQuestions]");
    expect(a.template).toContain("внутренний блок");
    const b = buildSystemPrompt({ ...template, code: "other", title: "Другая" });
    expect(b.stable).toBe(a.stable);
  });
});

import { speakerLabel } from "../src/llm/prompt.js";
describe("speakerLabel", () => {
  it("нумерует клиентов и вендоров отдельно", () => {
    const roles = { speaker_0: "ours" as const, speaker_1: "client" as const, speaker_3: "client" as const, speaker_2: "vendor" as const };
    expect(speakerLabel("speaker_0", {}, roles)).toBe("Спикер 1");
    expect(speakerLabel("speaker_1", {}, roles)).toBe("Клиент 1");
    expect(speakerLabel("speaker_3", {}, roles)).toBe("Клиент 2");
    expect(speakerLabel("speaker_2", {}, roles)).toBe("Вендор 1");
    expect(speakerLabel("speaker_1", { speaker_1: "Данияр" }, roles)).toBe("Данияр");
    expect(speakerLabel("speaker_5", {}, {})).toBe("Спикер 6");
  });
});
