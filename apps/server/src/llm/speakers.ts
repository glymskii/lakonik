import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { config } from "../config.js";
import { logger } from "../logger.js";
import type { meetings, transcripts } from "../db/schema/index.js";
import type { SpeakerSuggestions, TranscriptSegment } from "../db/types.js";
import { estimateCostUsd } from "./pricing.js";
import { formatTimestamp } from "./prompt.js";

type Meeting = typeof meetings.$inferSelect;
type Transcript = typeof transcripts.$inferSelect;

/** Структурированный ответ модели: кто есть кто среди спикеров диаризации */
export const SpeakersOut = z.object({
  estimatedSpeakerCount: z.number().int().min(1).describe("Сколько реально разных людей говорило (дубли диаризации не считать)"),
  speakers: z.array(
    z.object({
      speakerId: z.string().describe("id спикера из транскрипта, например speaker_2"),
      name: z.string().nullable().describe("Имя, только если оно прозвучало в разговоре (представился, к нему обращались) или совпало со списком участников; иначе null"),
      role: z.string().nullable().describe("Должность / роль, если прозвучала; иначе null"),
      company: z.string().nullable().describe("Компания / сторона, если прозвучала; иначе null"),
      side: z.enum(["ours", "client", "vendor", "unknown"]).describe("ours — сотрудник агентства (наша сторона), client — клиент, vendor — подрядчик/партнёр, unknown — не понятно"),
      confidence: z.enum(["high", "medium", "low"]),
      evidence: z.string().nullable().describe("Короткая цитата или объяснение, на чём основано предположение (до 120 символов)"),
      sameAs: z.string().nullable().describe("id другого спикера, если это, скорее всего, тот же человек (диаризация разделила одного говорящего): указывать у спикера с МЕНЬШИМ числом реплик, ссылаясь на «основного»; иначе null"),
    }),
  ),
  notes: z.string().nullable().describe("Одно-два предложения: что осталось неясным (до 200 символов)"),
});
export type SpeakersOutput = z.infer<typeof SpeakersOut>;

const SYSTEM = `Ты помогаешь агентству разобраться, кто говорил на встрече. На входе — расшифровка с автоматическим разделением
говорящих (speaker_0, speaker_1, …). Автоматическое разделение ошибается: одного человека может разбить на двух «спикеров»
(обычно у лишнего «спикера» мало реплик, они продолжают мысль другого, или он говорит о себе теми же словами), а двух
разных людей — слить в одного (это исправить нельзя, не пытайся).

Задача:
1. Оцени, сколько реально разных людей говорило.
2. Для каждого speaker_N определи имя, роль/должность и компанию ТОЛЬКО если это следует из разговора (представился,
   к нему обращаются по имени, кто-то называет его должность) или из списка участников, введённого пользователем.
   Ничего не выдумывай: если непонятно — null.
3. Определи сторону: ours — сотрудник агентства (ведёт встречу, говорит «мы подготовим», «наша команда», отвечает за
   предложение), client — представитель клиента/бренда (ставит задачу, утверждает, «у нас бюджет»), vendor — подрядчик,
   продакшн, площадка, медиаселлер. Если непонятно — unknown.
4. Отметь дубли диаризации через sameAs: у спикера с меньшим числом реплик укажи id «основного», если это явно тот же
   человек. Сомневаешься — null.
Отвечай по-русски, коротко, в заданной структуре.`;

export class SpeakerAnalysisError extends Error {
  constructor(
    message: string,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = "SpeakerAnalysisError";
  }
}

let client: Anthropic | null = null;
function anthropic(): Anthropic {
  client ??= new Anthropic({ apiKey: config().ANTHROPIC_API_KEY, maxRetries: 3, timeout: 5 * 60 * 1000 });
  return client;
}

/** Ключ contextFields с транскриптом Google Meet (кладёт авто-импорт, см. src/integrations/sync.ts) */
export const MEET_TRANSCRIPT_FIELD = "meetTranscript";

/** Компактная расшифровка со статистикой по спикерам; очень длинные транскрипты режем (для анализа хватает начала и середины) */
export function formatTranscriptForSpeakers(segments: TranscriptSegment[], maxChars = 60_000): string {
  const counts = new Map<string, number>();
  for (const s of segments) counts.set(s.speakerId, (counts.get(s.speakerId) ?? 0) + 1);
  const stats = [...counts.entries()].map(([id, n]) => `- ${id}: ${n} реплик`).join("\n");
  const lines = segments.map((s) => `[${formatTimestamp(s.start)}] ${s.speakerId}: ${s.text}`);
  let body = lines.join("\n");
  if (body.length > maxChars) {
    const head = body.slice(0, Math.floor(maxChars * 0.7));
    const tail = body.slice(-Math.floor(maxChars * 0.3));
    body = `${head}\n… (середина пропущена) …\n${tail}`;
  }
  return `СПИКЕРЫ ПО ДАННЫМ ДИАРИЗАЦИИ:\n${stats}\n\nРАСШИФРОВКА:\n${body}`;
}

export function buildSpeakersPrompt(m: Meeting, tr: Transcript): string {
  const parts: string[] = [];
  if (m.participantsHint.length) {
    parts.push("УЧАСТНИКИ ПО ДАННЫМ ПОЛЬЗОВАТЕЛЯ (имя · роль · компания):\n" + m.participantsHint.map((p) => `- ${[p.name, p.role, p.company].filter(Boolean).join(" · ")}${p.side ? ` (${p.side})` : ""}`).join("\n"));
  }
  const ctx = Object.entries(m.contextFields)
    .filter(([k, v]) => k !== MEET_TRANSCRIPT_FIELD && v != null && v !== "" && !(Array.isArray(v) && v.length === 0))
    .map(([k, v]) => `- ${k}: ${Array.isArray(v) ? v.join(", ") : String(v)}`);
  if (ctx.length) parts.push("КОНТЕКСТ ВСТРЕЧИ:\n" + ctx.join("\n"));
  // Транскрипт платформы (Google Meet) — готовое соответствие «имя ↔ реплика», сильная подсказка по спикерам
  const meet = m.contextFields[MEET_TRANSCRIPT_FIELD];
  if (typeof meet === "string" && meet.trim()) {
    parts.push(`ТРАНСКРИПТ ПЛАТФОРМЫ С ИМЕНАМИ (может расходиться с нашей расшифровкой по времени и словам, но имена в нём настоящие):\n${meet}`);
  }
  if (m.numSpeakersHint) parts.push(`Пользователь ожидал говорящих: ${m.numSpeakersHint}.`);
  parts.push(formatTranscriptForSpeakers(tr.segments));
  return parts.join("\n\n");
}

/** Анализ спикеров после расшифровки: быстрая модель, без размышлений, structured output */
export async function analyzeSpeakers(m: Meeting, tr: Transcript): Promise<{ result: SpeakerSuggestions; costUsd: number; usage: { input: number; output: number } }> {
  const cfg = config();
  const speakerIds = [...new Set(tr.segments.map((s) => s.speakerId))];
  if (cfg.FAKE_PROVIDERS) return { result: fakeSuggestions(speakerIds, m), costUsd: 0, usage: { input: 0, output: 0 } };
  if (!cfg.ANTHROPIC_API_KEY) throw new SpeakerAnalysisError("ANTHROPIC_API_KEY не задан", false);

  const model = cfg.ANTHROPIC_MODEL_DRAFT;
  const started = Date.now();
  try {
    const response = await anthropic().beta.messages.parse({
      model,
      max_tokens: 4000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "medium", format: zodOutputFormat(SpeakersOut) },
      system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: buildSpeakersPrompt(m, tr) }],
    });
    if (response.stop_reason === "refusal") throw new SpeakerAnalysisError("Модель отказалась анализировать спикеров", false);
    const parsed = response.parsed_output;
    if (!parsed) throw new SpeakerAnalysisError("Не удалось разобрать ответ модели", true);
    const usage = { input: response.usage.input_tokens, output: response.usage.output_tokens, cacheRead: response.usage.cache_read_input_tokens ?? 0, cacheWrite: response.usage.cache_creation_input_tokens ?? 0 };
    const costUsd = estimateCostUsd(response.model, usage);
    const result = normalize(parsed, speakerIds, response.model);
    logger.info({ meetingId: m.id, model: response.model, speakers: speakerIds.length, estimated: result.estimatedSpeakerCount, merges: result.speakers.filter((s) => s.sameAs).length, costUsd, ms: Date.now() - started }, "Анализ спикеров готов");
    return { result, costUsd, usage: { input: usage.input, output: usage.output } };
  } catch (e) {
    if (e instanceof SpeakerAnalysisError) throw e;
    if (e instanceof Anthropic.RateLimitError || e instanceof Anthropic.InternalServerError || e instanceof Anthropic.APIConnectionError) {
      throw new SpeakerAnalysisError(`Anthropic временно недоступен: ${(e as Error).message}`, true);
    }
    throw new SpeakerAnalysisError((e as Error).message, false);
  }
}

/** Оставляем только реальные id, убираем самоссылки и цепочки sameAs; для пропущенных спикеров — пустые записи */
export function normalize(out: SpeakersOutput, speakerIds: string[], model: string): SpeakerSuggestions {
  const known = new Set(speakerIds);
  const byId = new Map(out.speakers.filter((s) => known.has(s.speakerId)).map((s) => [s.speakerId, s]));
  const speakers = speakerIds.map((id) => {
    const s = byId.get(id);
    let sameAs = s?.sameAs && known.has(s.sameAs) && s.sameAs !== id ? s.sameAs : null;
    // цель слияния сама не должна быть «дублем» — иначе цепочка
    if (sameAs && byId.get(sameAs)?.sameAs) sameAs = null;
    return {
      speakerId: id,
      name: s?.name?.trim() || null,
      role: s?.role?.trim() || null,
      company: s?.company?.trim() || null,
      side: s?.side ?? "unknown",
      confidence: s?.confidence ?? "low",
      evidence: s?.evidence?.trim() || null,
      sameAs,
    };
  });
  const distinct = speakers.filter((s) => !s.sameAs).length;
  return {
    estimatedSpeakerCount: Math.max(1, Math.min(out.estimatedSpeakerCount, distinct)),
    speakers,
    notes: out.notes?.trim() || null,
    model,
    createdAt: new Date().toISOString(),
  };
}

function fakeSuggestions(speakerIds: string[], m: Meeting): SpeakerSuggestions {
  const hints = m.participantsHint;
  return {
    estimatedSpeakerCount: Math.max(1, speakerIds.length - (speakerIds.length > 2 ? 1 : 0)),
    speakers: speakerIds.map((id, i) => ({
      speakerId: id,
      name: hints[i]?.name ?? null,
      role: hints[i]?.role ?? null,
      company: hints[i]?.company ?? null,
      side: i === 0 ? "ours" : i === 1 ? "client" : "unknown",
      confidence: hints[i] ? "medium" : "low",
      evidence: hints[i] ? "по списку участников" : null,
      sameAs: speakerIds.length > 2 && i === speakerIds.length - 1 ? speakerIds[1]! : null,
    })),
    notes: "fake: подсказки сгенерированы заглушкой",
    model: "fake",
    createdAt: new Date().toISOString(),
  };
}
