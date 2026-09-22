import PDFDocument from "pdfkit";
import * as fontkit from "fontkit";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type { meetingTemplates } from "../db/schema/index.js";
import { assembleSections, formatDuration, type RenderMeta, type ReportRow } from "./markdown.js";

type Template = typeof meetingTemplates.$inferSelect;

const here = dirname(fileURLToPath(import.meta.url));
// В dev — src/export → ../../assets; в dist — dist/export → ../../assets (assets копируется в образ)
const FONT_DIR = resolve(here, "../../assets/fonts");
const REGULAR = resolve(FONT_DIR, "NotoSans-Regular.ttf");
const BOLD = resolve(FONT_DIR, "NotoSans-Bold.ttf");
// Noto Sans без стрелок, галочек и знаков ⚠ ≤ ≥ — такие символы рисуем DejaVu Sans (полное покрытие)
const SYMBOLS = resolve(FONT_DIR, "DejaVuSans.ttf");
const SYMBOLS_BOLD = resolve(FONT_DIR, "DejaVuSans-Bold.ttf");

const notoFont = fontkit.openSync(REGULAR) as fontkit.Font;
const dejavuFont = fontkit.openSync(SYMBOLS) as fontkit.Font;

/** Эмодзи и цветные значки, которых нет ни в одном встроенном шрифте, → текстовые аналоги */
const EMOJI_MAP: Record<string, string> = {
  "✅": "✔", "☑": "✔", "✳": "*", "❌": "✘", "❎": "✘", "⚠": "⚠", "🟢": "✔", "🟡": "⚠", "🔴": "✘", "🟠": "⚠",
  "🔒": "(конфиденциально)", "📌": "•", "💡": "•", "📅": "", "📎": "", "🚀": "", "👉": "→", "➡": "→", "⬅": "←", "🔥": "!", "❗": "!", "❓": "?",
};

/** Убирает вариационные селекторы и эмодзи, заменяет их на текст; символы без глифа в обоих шрифтах отбрасывает */
export function prepareText(text: string): string {
  let out = "";
  for (const ch of text.replace(/[\uFE0E\uFE0F\u200D]/g, "")) {
    const mapped = EMOJI_MAP[ch];
    if (mapped !== undefined) { out += mapped; continue; }
    const cp = ch.codePointAt(0)!;
    if (notoFont.hasGlyphForCodePoint(cp) || dejavuFont.hasGlyphForCodePoint(cp)) out += ch;
  }
  return out;
}

const needsSymbols = (text: string) => [...text].some((ch) => !notoFont.hasGlyphForCodePoint(ch.codePointAt(0)!));

/** Текст с переключением шрифта на DejaVu для символов, которых нет в Noto Sans (одним абзацем, с переносами) */
function writeRuns(doc: PDFKit.PDFDocument, text: string, bold: boolean, opts: PDFKit.Mixins.TextOptions = {}) {
  const runs: Array<{ text: string; sym: boolean }> = [];
  for (const ch of prepareText(text)) {
    const sym = !notoFont.hasGlyphForCodePoint(ch.codePointAt(0)!);
    const last = runs[runs.length - 1];
    if (last && last.sym === sym) last.text += ch;
    else runs.push({ text: ch, sym });
  }
  if (!runs.length) { doc.text("", opts); return; }
  runs.forEach((r, i) => {
    doc.font(r.sym ? (bold ? "SB" : "S") : bold ? "B" : "R");
    doc.text(r.text, { ...opts, continued: i < runs.length - 1 });
  });
  doc.font(bold ? "B" : "R");
}

export async function renderPdf(t: Template, r: ReportRow, meta: RenderMeta): Promise<Buffer> {
  const sections = assembleSections(t, r).filter((s) => meta.includeInternal || !s.internalOnly);
  const date = meta.startedAt.toLocaleString("ru-RU", { timeZone: "Asia/Almaty", dateStyle: "long", timeStyle: "short" });

  const doc = new PDFDocument({ size: "A4", margins: { top: 56, bottom: 56, left: 56, right: 56 }, info: { Title: prepareText(r.title), Author: "Lakonik" } });
  doc.registerFont("R", REGULAR);
  doc.registerFont("B", BOLD);
  doc.registerFont("S", SYMBOLS);
  doc.registerFont("SB", SYMBOLS_BOLD);
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((res) => doc.on("end", () => res(Buffer.concat(chunks))));

  const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;

  doc.font("B").fontSize(18).text(t.reportTitle);
  doc.moveDown(0.3);
  doc.fontSize(13); writeRuns(doc, r.title, true);
  doc.moveDown(0.5);
  doc.font("R").fontSize(10).fillColor("#444");
  doc.text(`Дата и время: ${date}`);
  const dur = formatDuration(meta.durationSec);
  if (dur) doc.text(`Длительность: ${dur}`);
  if (meta.platform) doc.text(`Место / платформа: ${meta.platform}`);
  doc.text(`Тип встречи: ${meta.templateTitle}`);
  if (meta.confidentiality === "restricted") doc.font("B").text("Конфиденциально");
  doc.fillColor("#000");

  sections.forEach((s, i) => {
    doc.moveDown(0.9);
    doc.fontSize(12); writeRuns(doc, `${i + 1}. ${s.heading}${s.internalOnly ? " (внутренний блок)" : ""}`, true);
    doc.moveDown(0.25);
    doc.font("R").fontSize(10.5);
    if (s.table) {
      if (s.table.rows.length) drawTable(doc, s.table.columns, s.table.rows, width);
      else doc.text("не озвучено, уточнить");
    } else {
      writeMarkdown(doc, s.content);
    }
  });

  if (r.missingInfo.length) {
    doc.moveDown(0.9);
    doc.font("B").fontSize(12).text("Не озвучено — уточнить");
    doc.moveDown(0.25);
    doc.font("R").fontSize(10.5);
    for (const m of r.missingInfo) writeRuns(doc, `• ${m}`, false);
  }

  doc.moveDown(1.2);
  doc.font("R").fontSize(8.5).fillColor("#777").text("Сформировано Lakonik автоматически по аудиозаписи. Проверьте факты и action items перед отправкой.");
  doc.end();
  return done;
}

function writeMarkdown(doc: PDFKit.PDFDocument, md: string) {
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
      drawTable(doc, columns, rows, doc.page.width - doc.page.margins.left - doc.page.margins.right);
      continue;
    }
    const clean = line.replace(/\*\*/g, "").replace(/(^|\s)_([^_]+)_(?=\s|$|[.,;:!?])/g, "$1$2");
    const bullet = clean.match(/^\s*[-•*]\s+(.*)$/);
    if (bullet) writeRuns(doc, `• ${bullet[1]}`, false, { indent: 10 });
    else if (clean.startsWith("### ")) writeRuns(doc, clean.slice(4), true);
    else if (clean.trim() === "") doc.moveDown(0.3);
    else writeRuns(doc, clean, false);
    i++;
  }
}

function splitRow(line: string): string[] {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, "|").trim());
}

function drawTable(doc: PDFKit.PDFDocument, columns: string[], rows: string[][], width: number) {
  const colW = columns.map((_, i) => (i === 1 && columns.length === 3 ? width * 0.5 : (width * 0.5) / (columns.length - 1)));
  const pad = 4;
  const drawRow = (rawCells: string[], bold: boolean) => {
    const cells = rawCells.map(prepareText);
    const fontFor = (c: string) => (needsSymbols(c) ? (bold ? "SB" : "S") : bold ? "B" : "R");
    const heights = cells.map((c, i) => doc.font(fontFor(c || "—")).heightOfString(c || "—", { width: (colW[i] ?? 100) - pad * 2 }) + pad * 2);
    const h = Math.max(...heights, 16);
    if (doc.y + h > doc.page.height - doc.page.margins.bottom) doc.addPage();
    const y = doc.y;
    let x = doc.page.margins.left;
    cells.forEach((c, i) => {
      const w = colW[i] ?? 100;
      doc.rect(x, y, w, h).strokeColor("#bbb").lineWidth(0.5).stroke();
      doc.font(fontFor(c || "—")).text(c || "—", x + pad, y + pad, { width: w - pad * 2 });
      x += w;
    });
    doc.x = doc.page.margins.left;
    doc.y = y + h;
  };
  drawRow(columns, true);
  for (const r of rows) drawRow(columns.map((_, i) => r[i] ?? ""), false);
  doc.font("R");
  doc.moveDown(0.3);
}
