import { describe, expect, it } from "vitest";
import { assembleSections, renderDocx, renderMarkdown } from "../src/export/index.js";
import { buildSystemPrompt } from "../src/llm/prompt.js";
import { catalog, findGroup, groupOf, legacyCatalog } from "../src/templates/catalog.js";
import { templateRow, syntheticReport, renderMeta } from "./fixtures/templates.js";

describe("встроенный каталог", () => {
  it("11 шаблонов с уникальными кодами", () => {
    const codes = catalog.templates.map((t) => t.code);
    expect(codes).toHaveLength(11);
    expect(new Set(codes).size).toBe(codes.length);
    expect(codes).toEqual([
      "client_intro",
      "client_brief",
      "client_status",
      "client_review",
      "internal_status",
      "internal_brief",
      "internal_management",
      "partner_negotiation",
      "one_on_one",
      "interview",
      "lecture",
    ]);
  });

  it("группы и категории известны, группы — пять новых", () => {
    expect(catalog.groups.map((g) => g.code)).toEqual(["client", "internal", "partner", "people", "notes"]);
    const cats = new Set(catalog.categories.map((c) => c.code));
    for (const t of catalog.templates) {
      expect(() => groupOf(t.group)).not.toThrow();
      expect(cats.has(t.category)).toBe(true);
    }
  });

  it("у каждого шаблона есть поля, спрашиваемые до записи, правила и советы", () => {
    for (const t of catalog.templates) {
      const ask = t.specificFields.filter((f) => f.askBeforeRecording);
      expect(ask.length, t.code).toBeGreaterThanOrEqual(2);
      expect(t.specificFields.length, t.code).toBeGreaterThanOrEqual(3);
      expect(t.specificFields.length, t.code).toBeLessThanOrEqual(6);
      expect(t.rules.length, t.code).toBeGreaterThanOrEqual(4);
      expect(t.rules.length, t.code).toBeLessThanOrEqual(8);
      expect(t.tips.length, t.code).toBeGreaterThanOrEqual(3);
      expect(t.tips.length, t.code).toBeLessThanOrEqual(5);
      // ключи полей не пересекаются с общими и не дублируются
      const keys = t.specificFields.map((f) => f.key);
      expect(new Set(keys).size, t.code).toBe(keys.length);
      for (const c of catalog.commonFields) expect(keys, t.code).not.toContain(c.key);
    }
  });

  it("SLA: внешние встречи 48 часов, внутренние 24", () => {
    for (const t of catalog.templates) {
      const external = t.group === "client" || t.group === "partner";
      expect(t.slaHours, t.code).toBe(external ? 48 : 24);
    }
  });

  it("личные встречи и собеседования — restricted, у совещания руководства есть выбор конфиденциальности", () => {
    const by = (code: string) => catalog.templates.find((t) => t.code === code)!;
    expect(by("one_on_one").confidentiality).toBe("restricted");
    expect(by("interview").confidentiality).toBe("restricted");
    expect(by("internal_management").allowConfidentialityChoice).toBe(true);
    expect(by("client_review").reportSections.some((s) => s.internalOnly)).toBe(true);
  });

  it("структура разделов: резюме, участники, action plan; структурные разделы не дублируются", () => {
    for (const t of catalog.templates) {
      const keys = t.reportSections.map((s) => s.key);
      const kinds = t.reportSections.map((s) => s.kind);
      expect(new Set(keys).size, t.code).toBe(keys.length);
      expect(keys, t.code).toContain("summary");
      expect(kinds, t.code).toContain("participants");
      expect(kinds, t.code).toContain("action_plan");
      const structural = kinds.filter((k) => k !== "text");
      expect(new Set(structural).size, t.code).toBe(structural.length);
    }
  });

  it("в пользовательских текстах нет названий агентств и холдинга", () => {
    const text = JSON.stringify(catalog.templates) + JSON.stringify(catalog.groups) + JSON.stringify(catalog.globalRules);
    expect(text).not.toMatch(/ADV|агентств|холдинг/i);
  });
});

describe("рендер каждого встроенного шаблона", () => {
  for (const t of catalog.templates) {
    it(`${t.code}: markdown и docx содержат все разделы`, async () => {
      const template = templateRow(t);
      const report = syntheticReport(t);
      const sections = assembleSections(template, report);
      expect(sections).toHaveLength(t.reportSections.length);
      for (const s of sections) expect(s.content.trim(), `${t.code}/${s.key}`).not.toBe("");

      const md = renderMarkdown(template, report, renderMeta(t.title));
      expect(md).toContain(`# ${t.reportTitle}`);
      t.reportSections.forEach((s, i) => {
        expect(md, `${t.code}/${s.key}`).toContain(`## ${i + 1}. ${s.heading}`);
      });
      expect(md).toContain("| Ответственный | Задача | Дедлайн |");

      const docx = await renderDocx(template, report, renderMeta(t.title));
      expect(docx.byteLength).toBeGreaterThan(1000);
    });
  }

  it("внутренние разделы не попадают во внешнюю версию", () => {
    const t = catalog.templates.find((x) => x.code === "client_review")!;
    const internal = t.reportSections.find((s) => s.internalOnly)!;
    const md = renderMarkdown(templateRow(t), syntheticReport(t), { ...renderMeta(t.title), includeInternal: false });
    expect(md).not.toContain(internal.heading);
    expect(renderMarkdown(templateRow(t), syntheticReport(t), renderMeta(t.title))).toContain(`${internal.heading} 🔒`);
  });

  it("системный промпт берёт правила конкретного шаблона", () => {
    const t = catalog.templates.find((x) => x.code === "internal_status")!;
    const p = buildSystemPrompt(templateRow(t));
    for (const rule of t.rules) expect(p.template).toContain(rule);
    expect(p.template).toContain("СВЕТОФОР ПО НАПРАВЛЕНИЯМ");
    // стабильная часть одинакова для разных шаблонов и содержит общие правила каталога
    const other = buildSystemPrompt(templateRow(catalog.templates[0]!));
    expect(other.stable).toBe(p.stable);
    for (const rule of catalog.globalRules) expect(p.stable).toContain(rule);
  });
});

describe("приватный каталог организации переноса", () => {
  it("12 шаблонов с уникальными кодами и известными группами", () => {
    const codes = legacyCatalog.templates.map((t) => t.code);
    expect(codes).toHaveLength(12);
    expect(new Set(codes).size).toBe(codes.length);
    expect(legacyCatalog.groups.map((g) => g.code)).toEqual(["internal", "client", "vendor"]);
    for (const t of legacyCatalog.templates) expect(() => groupOf(t.group, legacyCatalog)).not.toThrow();
  });

  it("findGroup находит группы обоих каталогов — из них /templates собирает список групп", () => {
    // встроенные группы имеют приоритет, группы приватного каталога добавляются следом
    for (const g of catalog.groups) expect(findGroup(g.code)).toBe(g);
    const vendor = findGroup("vendor");
    expect(vendor?.title).toBe(legacyCatalog.groups.find((g) => g.code === "vendor")!.title);
    expect(findGroup("internal")).toBe(catalog.groups.find((g) => g.code === "internal"));
    expect(findGroup("неизвестная")).toBeUndefined();
  });

  it("коды каталогов не конфликтуют по смыслу групп", () => {
    // общие коды у двух каталогов допустимы: приватный шаблон перекрывает встроенный в /templates
    const shared = legacyCatalog.templates.map((t) => t.code).filter((c) => catalog.templates.some((t) => t.code === c));
    for (const code of shared) {
      const a = catalog.templates.find((t) => t.code === code)!;
      const b = legacyCatalog.templates.find((t) => t.code === code)!;
      expect(a.group, code).toBe(b.group);
    }
  });
});
