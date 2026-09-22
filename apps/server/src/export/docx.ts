import {
  AlignmentType,
  BorderStyle,
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from "docx";
import type { meetingTemplates } from "../db/schema/index.js";
import { assembleSections, formatDuration, type RenderMeta, type ReportRow } from "./markdown.js";

type Template = typeof meetingTemplates.$inferSelect;

const FONT = "Calibri";

/** Простой конвертер markdown-фрагментов (списки, **жирный**, абзацы, таблицы |a|b|) в параграфы docx. */
function mdToParagraphs(md: string): (Paragraph | Table)[] {
  const out: (Paragraph | Table)[] = [];
  const lines = md.split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] ?? "")) {
      const columns = splitRow(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i] ?? "")) {
        rows.push(splitRow(lines[i] ?? ""));
        i++;
      }
      out.push(table(columns, rows));
      continue;
    }
    const bullet = line.match(/^\s*[-•*]\s+(.*)$/);
    const numbered = line.match(/^\s*(\d+)[.)]\s+(.*)$/);
    if (bullet) out.push(new Paragraph({ children: runs(bullet[1] ?? ""), bullet: { level: 0 }, spacing: { after: 60 } }));
    else if (numbered) out.push(new Paragraph({ children: runs(`${numbered[1]}. ${numbered[2] ?? ""}`), indent: { left: 360 }, spacing: { after: 60 } }));
    else if (line.trim() === "") {
      /* пропускаем пустые */
    } else if (line.startsWith("### ")) out.push(new Paragraph({ children: [new TextRun({ text: line.slice(4), bold: true, font: FONT })], spacing: { before: 120, after: 60 } }));
    else out.push(new Paragraph({ children: runs(line), spacing: { after: 100 } }));
    i++;
  }
  return out;
}

function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split(/(?<!\\)\|/)
    .map((c) => c.replace(/\\\|/g, "|").trim());
}

/** **жирный** и _курсив_ → TextRun */
function runs(text: string): TextRun[] {
  const parts = text.split(/(\*\*[^*]+\*\*|_[^_]+_)/g).filter(Boolean);
  return parts.map((p) => {
    if (p.startsWith("**") && p.endsWith("**")) return new TextRun({ text: p.slice(2, -2), bold: true, font: FONT });
    if (p.startsWith("_") && p.endsWith("_") && p.length > 2) return new TextRun({ text: p.slice(1, -1), italics: true, font: FONT });
    return new TextRun({ text: p, font: FONT });
  });
}

/** Ширина текстовой области A4 при полях 2,54 см — в DXA (1/20 пункта) */
const PAGE_WIDTH_DXA = 9026;

function table(columns: string[], rows: string[][]): Table {
  const border = { style: BorderStyle.SINGLE, size: 4, color: "BFBFBF" };
  // Без явных ширин Word (в отличие от Pages/LibreOffice) показывает таблицу схлопнутой — колонки нулевой ширины
  const widths = columns.length === 3 ? [0.25, 0.5, 0.25].map((f) => Math.round(PAGE_WIDTH_DXA * f)) : columns.map(() => Math.round(PAGE_WIDTH_DXA / columns.length));
  const cell = (text: string, ci: number, header = false) =>
    new TableCell({
      width: { size: widths[ci] ?? Math.round(PAGE_WIDTH_DXA / columns.length), type: WidthType.DXA },
      children: [new Paragraph({ children: [new TextRun({ text, bold: header, font: FONT, size: 20 })] })],
      shading: header ? { fill: "EDEDED" } : undefined,
      borders: { top: border, bottom: border, left: border, right: border },
    });
  return new Table({
    width: { size: PAGE_WIDTH_DXA, type: WidthType.DXA },
    columnWidths: widths,
    rows: [
      new TableRow({ tableHeader: true, children: columns.map((c, ci) => cell(c, ci, true)) }),
      ...rows.map((r) => new TableRow({ children: columns.map((_, ci) => cell(r[ci] ?? "", ci)) })),
    ],
  });
}

export async function renderDocx(t: Template, r: ReportRow, meta: RenderMeta): Promise<Buffer> {
  const sections = assembleSections(t, r).filter((s) => meta.includeInternal || !s.internalOnly);
  const date = meta.startedAt.toLocaleString("ru-RU", { timeZone: "Asia/Almaty", dateStyle: "long", timeStyle: "short" });

  const children: (Paragraph | Table)[] = [
    new Paragraph({ text: t.reportTitle, heading: HeadingLevel.TITLE }),
    new Paragraph({ children: [new TextRun({ text: r.title, bold: true, size: 26, font: FONT })], spacing: { after: 160 } }),
    new Paragraph({ children: runs(`Дата и время: ${date}`), spacing: { after: 40 } }),
  ];
  const dur = formatDuration(meta.durationSec);
  if (dur) children.push(new Paragraph({ children: runs(`Длительность: ${dur}`), spacing: { after: 40 } }));
  if (meta.platform) children.push(new Paragraph({ children: runs(`Место / платформа: ${meta.platform}`), spacing: { after: 40 } }));
  children.push(new Paragraph({ children: runs(`Тип встречи: ${meta.templateTitle}`), spacing: { after: 40 } }));
  if (meta.confidentiality === "restricted") children.push(new Paragraph({ children: [new TextRun({ text: "🔒 Конфиденциально", bold: true, font: FONT })], spacing: { after: 160 } }));

  sections.forEach((s, i) => {
    children.push(new Paragraph({ text: `${i + 1}. ${s.heading}${s.internalOnly ? " 🔒" : ""}`, heading: HeadingLevel.HEADING_2, spacing: { before: 240, after: 80 } }));
    if (s.internalOnly) children.push(new Paragraph({ children: [new TextRun({ text: "Внутренний блок — не для внешней стороны.", italics: true, font: FONT, color: "7A7A7A" })], spacing: { after: 80 } }));
    if (s.table) children.push(s.table.rows.length ? table(s.table.columns, s.table.rows) : new Paragraph({ children: runs("не озвучено, уточнить") }));
    else children.push(...mdToParagraphs(s.content));
  });

  if (r.missingInfo.length) {
    children.push(new Paragraph({ text: "⚠️ Не озвучено — уточнить", heading: HeadingLevel.HEADING_2, spacing: { before: 240, after: 80 } }));
    for (const m of r.missingInfo) children.push(new Paragraph({ children: runs(m), bullet: { level: 0 } }));
  }
  children.push(
    new Paragraph({
      children: [new TextRun({ text: "Сформировано Lakonik автоматически по аудиозаписи. Проверьте факты и action items перед отправкой.", italics: true, color: "7A7A7A", size: 18, font: FONT })],
      spacing: { before: 360 },
      alignment: AlignmentType.LEFT,
    }),
  );

  const doc = new Document({
    creator: "Lakonik",
    title: r.title,
    styles: { default: { document: { run: { font: FONT, size: 22 } } } },
    sections: [{ properties: {}, children }],
  });
  return Packer.toBuffer(doc);
}
