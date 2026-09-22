import type { meetingTemplates, meetings, transcripts } from "../db/schema/index.js";
import type { Marker, Participant, SpeakerMap, SpeakerRole, SpeakerRoleMap, TranscriptSegment } from "../db/types.js";
import { catalog } from "../templates/catalog.js";

type Template = typeof meetingTemplates.$inferSelect;
type Meeting = typeof meetings.$inferSelect;
type Transcript = typeof transcripts.$inferSelect;

export const GLOBAL_RULES = catalog.globalRules;

/**
 * System-промпт: стабильная часть (роль + глобальные правила) + часть шаблона.
 * Обе части детерминированы для данной версии шаблона → кешируются (cache_control).
 */
export function buildSystemPrompt(t: Template): { stable: string; template: string } {
  const stable = [
    "Ты — профессиональный ассистент, который составляет контакт-репорты и протоколы встреч по транскриптам аудиозаписей для команд, агентств и их клиентов.",
    "",
    "ОБЩИЕ ПРАВИЛА:",
    ...GLOBAL_RULES.map((r, i) => `${i + 1}. ${r}`),
    "",
    "ФОРМАТ ВЫВОДА: строго JSON по заданной схеме. В массив sections включай только текстовые разделы (kind=text) — по одному объекту на раздел, key ровно как в шаблоне, content в markdown (списки, подпункты, таблицы там, где просит шаблон). Разделы других типов (участники, action plan, решения, открытые вопросы, запросы к клиенту, следующая встреча) заполняй через отдельные поля participants / actionItems / decisions / openQuestions / clientRequests / nextMeeting — в sections их не дублируй.",
  ].join("\n");

  const sectionsText = t.reportSections
    .map((s, i) => {
      const flags = [s.internalOnly ? "внутренний блок — не для внешней стороны" : null].filter(Boolean).join("; ");
      const kindNote =
        s.kind === "text"
          ? "sections[].content"
          : s.kind === "participants"
            ? "поле participants"
            : s.kind === "action_plan"
              ? "поле actionItems"
              : s.kind === "decisions"
                ? "поле decisions"
                : s.kind === "open_questions"
                  ? "поле openQuestions"
                  : s.kind === "client_requests"
                    ? "поле clientRequests"
                    : "поле nextMeeting";
      return `${i + 1}. ${s.heading} [key=${s.key}; заполняется через ${kindNote}${flags ? "; " + flags : ""}]${s.guidance ? `\n   Указания: ${s.guidance}` : ""}`;
    })
    .join("\n");

  const template = [
    `ТИП ВСТРЕЧИ: ${t.title}${t.subtitle ? ` — ${t.subtitle}` : ""}`,
    `ЦЕЛЬ: ${t.goal}`,
    `ЗАГОЛОВОК ДОКУМЕНТА: ${t.reportTitle}`,
    `ТОН: ${t.tone ?? "профессиональный, деловой"}. Язык: русский.`,
    "",
    "СТРУКТУРА ОТЧЁТА (соблюдай порядок и ключи):",
    sectionsText,
    "",
    "ПРАВИЛА ДЛЯ ЭТОГО ТИПА ВСТРЕЧИ:",
    ...t.rules.map((r, i) => `${i + 1}. ${r}`),
  ].join("\n");

  return { stable, template };
}

export function formatTimestamp(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}` : `${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
}

const ROLE_LABEL: Record<SpeakerRole, string> = { ours: "Коллега", client: "Клиент", vendor: "Вендор" };

/**
 * Подпись спикера: имя от пользователя → «Клиент N» / «Вендор N» (нумерация среди спикеров той же роли в порядке speaker_id) → «Спикер N».
 */
export function speakerLabel(speakerId: string, map: SpeakerMap, roles: SpeakerRoleMap = {}): string {
  const custom = map[speakerId];
  if (custom && custom.trim()) return custom.trim();
  const role = roles[speakerId];
  if (role === "client" || role === "vendor") {
    const sameRole = Object.entries(roles)
      .filter(([, r]) => r === role)
      .map(([id]) => id)
      .sort((a, b) => speakerIndex(a) - speakerIndex(b));
    const idx = sameRole.indexOf(speakerId);
    return `${ROLE_LABEL[role]} ${idx >= 0 ? idx + 1 : 1}`;
  }
  const n = speakerIndex(speakerId);
  return Number.isFinite(n) ? `Спикер ${n + 1}` : speakerId;
}

function speakerIndex(speakerId: string): number {
  return Number.parseInt(speakerId.replace(/\D+/g, ""), 10);
}

export function formatTranscript(segments: TranscriptSegment[], speakers: SpeakerMap, roles: SpeakerRoleMap = {}): string {
  return segments.map((s) => `[${formatTimestamp(s.start)}] ${speakerLabel(s.speakerId, speakers, roles)}: ${s.text}`).join("\n");
}

function formatContext(t: Template, m: Meeting): string {
  const fields = [...t.commonFields, ...t.specificFields];
  const lines: string[] = [];
  for (const f of fields) {
    const v = m.contextFields[f.key];
    if (v == null || v === "" || (Array.isArray(v) && v.length === 0)) continue;
    lines.push(`- ${f.label}: ${Array.isArray(v) ? v.join(", ") : String(v)}`);
  }
  return lines.length ? lines.join("\n") : "- (пользователь ничего не заполнил — извлекай всё из транскрипта)";
}

function formatParticipantsHint(p: Participant[]): string {
  if (!p.length) return "";
  return "\nУЧАСТНИКИ (по данным пользователя):\n" + p.map((x) => `- ${[x.name, x.role, x.company].filter(Boolean).join(" · ")}`).join("\n");
}

function formatMarkers(markers: Marker[]): string {
  if (!markers.length) return "";
  return "\nОТМЕТКИ ПОЛЬЗОВАТЕЛЯ ВО ВРЕМЯ ЗАПИСИ (важные моменты):\n" + markers.map((mk) => `- [${formatTimestamp(mk.atSec)}] ${mk.note?.trim() || "важный момент"}`).join("\n");
}

export interface RevisionContext {
  instructions?: string;
  previousMarkdown?: string;
}

export function buildUserPrompt(t: Template, m: Meeting, tr: Transcript, revision: RevisionContext = {}): string {
  const date = m.startedAt.toLocaleString("ru-RU", { timeZone: "Asia/Almaty", dateStyle: "long", timeStyle: "short" });
  const isoDate = new Date(m.startedAt.getTime() + 5 * 3600 * 1000).toISOString().slice(0, 10);
  const weekday = m.startedAt.toLocaleDateString("ru-RU", { timeZone: "Asia/Almaty", weekday: "long" });
  const dur = m.durationSec ? `${Math.round(m.durationSec / 60)} мин` : tr.audioDurationSec ? `${Math.round(Number(tr.audioDurationSec) / 60)} мин` : "неизвестно";
  const speakers = tr.speakers ?? {};
  const roles = tr.speakerRoles ?? {};
  const selfNote = tr.selfSpeakerId
    ? `\nВЛАДЕЛЕЦ ЗАПИСИ: ${speakerLabel(tr.selfSpeakerId, speakers, roles)} (${tr.selfSpeakerId}) — это пользователь приложения, автор отчёта, сотрудник агентства (сторона «ours»). Задачи, которые он берёт на себя («я сделаю», «беру на себя»), записывай на его имя.`
    : "";
  const allIds = [...new Set([...tr.segments.map((s) => s.speakerId), ...Object.keys(speakers), ...Object.keys(roles)])].sort();
  const hasMap = Object.keys(speakers).length > 0 || Object.keys(roles).length > 0;
  const roleText: Record<SpeakerRole, string> = { ours: "сотрудник агентства (сторона ours)", client: "представитель клиента (сторона client)", vendor: "представитель вендора/подрядчика (сторона vendor)" };
  const speakerLines = (hasMap
    ? "\nКАРТА СПИКЕРОВ (задана пользователем; в транскрипте используются эти подписи):\n" +
      allIds.map((id) => `- ${id} → ${speakerLabel(id, speakers, roles)}${roles[id] ? ` — ${roleText[roles[id]!]}` : ""}`).join("\n") +
      "\nСпикеров без имени (например «Клиент 1», «Спикер 3») в отчёте так и называй, не выдумывай имена; если по контексту имя ясно (представился, обращаются по имени) — используй его."
    : "\nКарта спикеров не задана: в транскрипте спикеры обозначены как «Спикер N». Если по контексту ясно, кто это (представился, обращаются по имени) — используй имя, иначе оставляй «Спикер N».") + selfNote;

  return [
    "ДАННЫЕ ВСТРЕЧИ:",
    `- Тип: ${t.title}`,
    `- Дата и время: ${date} (Алматы), ${weekday}; ISO-дата встречи: ${isoDate} — от неё считай относительные сроки («к пятнице», «через неделю», «20-го»)`,
    `- Длительность: ${dur}`,
    `- Платформа / место: ${m.platform ?? "не указано"}`,
    `- Язык записи: ${tr.languageCode ?? "авто"}`,
    "",
    "КОНТЕКСТ ОТ ПОЛЬЗОВАТЕЛЯ (заполнен до/после встречи):",
    formatContext(t, m),
    formatParticipantsHint(m.participantsHint),
    speakerLines,
    formatMarkers(m.markers),
    "",
    "ТРАНСКРИПТ (автоматическая расшифровка, возможны ошибки распознавания имён и терминов — исправляй по контексту):",
    "<transcript>",
    formatTranscript(tr.segments, speakers, roles),
    "</transcript>",
    ...revisionBlock(revision),
    "",
    revision.instructions
      ? "Подготовь НОВУЮ версию отчёта по структуре шаблона с учётом правок пользователя. Верни только JSON."
      : "Составь отчёт по структуре шаблона. Верни только JSON.",
  ].join("\n");
}

function revisionBlock(r: RevisionContext): string[] {
  if (!r.instructions?.trim()) return [];
  const out: string[] = [""];
  if (r.previousMarkdown?.trim()) {
    out.push("ПРЕДЫДУЩАЯ ВЕРСИЯ ОТЧЁТА (её нужно исправить, а не переписывать с нуля — сохраняй всё, что не затронуто правками, включая формулировки, которые пользователь мог редактировать вручную):");
    out.push("<previous_report>");
    out.push(r.previousMarkdown.trim().slice(0, 40_000));
    out.push("</previous_report>");
    out.push("");
  }
  out.push("ПРАВКИ ОТ ПОЛЬЗОВАТЕЛЯ (обязательно выполнить; если правка противоречит транскрипту — выполни её, но отметь расхождение в missingInfo):");
  out.push("<instructions>");
  out.push(r.instructions.trim().slice(0, 4_000));
  out.push("</instructions>");
  return out;
}
