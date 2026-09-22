import type { meetingTemplates, reports } from "../db/schema/index.js";
import type { ReportSection } from "../db/types.js";

type Template = typeof meetingTemplates.$inferSelect;
export type ReportRow = typeof reports.$inferSelect;

/** Собранный для рендера отчёт: разделы в порядке шаблона, структурные блоки уже развёрнуты. */
export interface RenderedSection {
  key: string;
  heading: string;
  kind: string;
  internalOnly: boolean;
  /** markdown-содержимое */
  content: string;
  /** для табличных блоков — строки таблицы */
  table?: { columns: string[]; rows: string[][] };
  /** для списков */
  items?: string[];
}

const dash = (v: string | null | undefined) => (v && v.trim() ? v.trim() : "—");

export function formatDuration(sec: number | null): string | null {
  if (!sec || sec <= 0) return null;
  if (sec < 60) return "меньше минуты";
  const m = Math.round(sec / 60);
  if (m < 60) return `${m} мин`;
  return m % 60 === 0 ? `${m / 60} ч` : `${Math.floor(m / 60)} ч ${m % 60} мин`;
}

export function assembleSections(t: Template, r: ReportRow): RenderedSection[] {
  const byKey = new Map<string, ReportSection>(r.sections.map((s) => [s.key, s]));
  const out: RenderedSection[] = [];
  for (const s of t.reportSections) {
    const base = { key: s.key, heading: s.heading, kind: s.kind, internalOnly: !!s.internalOnly };
    switch (s.kind) {
      case "text": {
        const content = s.key === "summary" && !byKey.get(s.key)?.content ? r.summary : (byKey.get(s.key)?.content ?? "не озвучено, уточнить");
        out.push({ ...base, content });
        break;
      }
      case "participants": {
        const items = r.participants.map((p) => [p.name, p.role, p.company].filter((x) => x && x.trim()).join(" · "));
        out.push({ ...base, items, content: items.length ? items.map((i) => `- ${i}`).join("\n") : "не озвучено, уточнить" });
        break;
      }
      case "action_plan": {
        const rows = r.actionItems.map((a) => [dash(a.assignee), a.task, dash(a.deadline)]);
        out.push({ ...base, table: { columns: ["Ответственный", "Задача", "Дедлайн"], rows }, content: tableMd(["Ответственный", "Задача", "Дедлайн"], rows) });
        break;
      }
      case "decisions": {
        const rows = r.decisions.map((d) => [d.decision, dash(d.owner), dash(d.deadline)]);
        out.push({ ...base, table: { columns: ["Решение", "Ответственный", "Срок"], rows }, content: tableMd(["Решение", "Ответственный", "Срок"], rows) });
        break;
      }
      case "open_questions": {
        out.push({ ...base, items: r.openQuestions, content: listMd(r.openQuestions) });
        break;
      }
      case "client_requests": {
        out.push({ ...base, items: r.clientRequests, content: listMd(r.clientRequests) });
        break;
      }
      case "next_meeting": {
        const nm = r.nextMeeting;
        const items = nm ? [`Когда: ${dash(nm.when)}`, `Формат: ${dash(nm.format)}`, `Повестка / цель: ${dash(nm.agenda)}`] : [];
        out.push({ ...base, items, content: items.length ? items.map((i) => `- ${i}`).join("\n") : "не озвучено, уточнить" });
        break;
      }
    }
  }
  return out;
}

function esc(s: string) {
  return s.replace(/\|/g, "\\|").replace(/\n+/g, " ");
}

export function tableMd(columns: string[], rows: string[][]): string {
  if (!rows.length) return "не озвучено, уточнить";
  const head = `| ${columns.join(" | ")} |\n| ${columns.map(() => "---").join(" | ")} |`;
  return head + "\n" + rows.map((r) => `| ${r.map(esc).join(" | ")} |`).join("\n");
}

export function listMd(items: string[]): string {
  return items.length ? items.map((i) => `- ${i}`).join("\n") : "нет";
}

export interface RenderMeta {
  startedAt: Date;
  durationSec: number | null;
  platform: string | null;
  templateTitle: string;
  confidentiality: "standard" | "restricted";
  includeInternal: boolean;
}

export function renderMarkdown(t: Template, r: ReportRow, meta: RenderMeta): string {
  const sections = assembleSections(t, r).filter((s) => meta.includeInternal || !s.internalOnly);
  const date = meta.startedAt.toLocaleString("ru-RU", { timeZone: "Asia/Almaty", dateStyle: "long", timeStyle: "short" });
  const lines: string[] = [];
  lines.push(`# ${t.reportTitle}`);
  lines.push("");
  lines.push(`**${r.title}**`);
  lines.push("");
  lines.push(`- Дата и время: ${date}`);
  const dur = formatDuration(meta.durationSec);
  if (dur) lines.push(`- Длительность: ${dur}`);
  if (meta.platform) lines.push(`- Место / платформа: ${meta.platform}`);
  lines.push(`- Тип встречи: ${meta.templateTitle}`);
  if (meta.confidentiality === "restricted") lines.push(`- 🔒 Конфиденциально`);
  lines.push("");
  sections.forEach((s, i) => {
    lines.push(`## ${i + 1}. ${s.heading}${s.internalOnly ? " 🔒" : ""}`);
    if (s.internalOnly) lines.push("_Внутренний блок — не для внешней стороны._");
    lines.push("");
    lines.push(s.content);
    lines.push("");
  });
  if (r.missingInfo.length) {
    lines.push("## ⚠️ Не озвучено — уточнить");
    lines.push("");
    lines.push(listMd(r.missingInfo));
    lines.push("");
  }
  lines.push("---");
  lines.push(`_Сформировано Lakonik автоматически по аудиозаписи. Проверьте факты и action items перед отправкой._`);
  return lines.join("\n");
}
