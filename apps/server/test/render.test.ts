import { describe, expect, it } from "vitest";
import { renderMarkdown, formatDuration } from "../src/export/markdown.js";
import { buildSystemPrompt } from "../src/llm/prompt.js";
import { catalog } from "../src/templates/catalog.js";
import { renderMeta, syntheticReport, templateRow } from "./fixtures/templates.js";

const byCode = (code: string) => catalog.templates.find((t) => t.code === code)!;

const tpl = byCode("client_brief");
const template = templateRow(tpl);

const report = {
  ...syntheticReport(tpl),
  title: "Летняя кампания — бриф",
  summary: "Клиент передал бриф на летнюю кампанию.",
  sections: [
    { key: "brief", heading: "БРИФ", content: "- Продукт: **Nomad**\n- Бюджет: 40 млн ₸" },
    { key: "budget_timing", heading: "БЮДЖЕТ И СРОКИ", content: "Бюджет 40 млн ₸, старт 1 июня." },
  ],
  actionItems: [{ assignee: "Айгерим", task: "Медиаплан", deadline: "20 мая", deadlineDate: null, quote: null, done: false }],
  openQuestions: ["Tone of voice"],
  missingInfo: ["Бюджет продакшна"],
  nextMeeting: { when: "25 мая", format: "Zoom", agenda: "Защита медиаплана" },
};

const meta = renderMeta("Бриф от клиента");

describe("renderMarkdown", () => {
  it("рендерит разделы в порядке шаблона с таблицей action plan", () => {
    const md = renderMarkdown(template, report, meta);
    expect(md).toContain("# Отчёт по встрече: бриф от клиента");
    expect(md.indexOf("## 1. РЕЗЮМЕ ЗАДАЧИ")).toBeLessThan(md.indexOf("## 3. БРИФ"));
    expect(md).toContain("| Айгерим | Медиаплан | 20 мая |");
    expect(md).toContain("Длительность: 1 ч");
    expect(md).toContain("- Бюджет продакшна");
    // раздел без содержимого от модели не ломает рендер
    expect(md).toContain("## 5. КАКОЙ РЕЗУЛЬТАТ ЖДЁТ КЛИЕНТ");
  });

  it("скрывает внутренние блоки для внешней версии", () => {
    const review = byCode("client_review");
    const full = renderMarkdown(templateRow(review), syntheticReport(review), renderMeta(review.title));
    const external = renderMarkdown(templateRow(review), syntheticReport(review), { ...renderMeta(review.title), includeInternal: false });
    expect(full).toContain("ВНУТРЕННИЕ ВЫВОДЫ — НЕ ДЛЯ КЛИЕНТА 🔒");
    expect(external).not.toContain("ВНУТРЕННИЕ ВЫВОДЫ");
    expect(external).toContain("ЧТО ДЕЛАЕМ ДАЛЬШЕ");
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
    const a = buildSystemPrompt(templateRow(byCode("client_intro")));
    expect(a.stable).toContain("ОБЩИЕ ПРАВИЛА");
    expect(a.template).toContain("ВОПРОСЫ К КЛИЕНТУ [key=client_questions; заполняется через поле openQuestions]");
    expect(buildSystemPrompt(templateRow(byCode("client_review"))).template).toContain("внутренний блок");
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
