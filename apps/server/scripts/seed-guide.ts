/**
 * Дополнение к seed-showcase для скриншотов памятки сотрудникам: убирает тестовые встречи демо-пользователя
 * и добавляет встречу в статусе «Расшифровка готова» с подсказками ИИ по спикерам (экран «Кто говорил»).
 *   pnpm --filter @lakonik/server exec tsx --env-file=.env scripts/seed-guide.ts [email]
 */
import { and, eq, inArray, like, or } from "drizzle-orm";
import { closeDb, db } from "../src/db/client.js";
import { meetingTemplates, meetings, transcripts, user } from "../src/db/schema/index.js";
import type { SpeakerSuggestions, TranscriptSegment } from "../src/db/types.js";

const email = process.argv[2] ?? "asel.nurlanova@orbita.kz";
const d = db();
const [owner] = await d.select({ id: user.id }).from(user).where(eq(user.email, email)).limit(1);
if (!owner) throw new Error(`нет пользователя ${email} — сначала seed-showcase`);

// Тестовые артефакты в списке демо-пользователя
const junk = await d.select({ id: meetings.id }).from(meetings).where(and(eq(meetings.ownerId, owner.id), or(like(meetings.title, "E2E%"), like(meetings.title, "Запись %"), eq(meetings.status, "failed"))));
if (junk.length) await d.delete(meetings).where(inArray(meetings.id, junk.map((m) => m.id)));

const [tpl] = await d.select().from(meetingTemplates).where(eq(meetingTemplates.code, "unclassified")).limit(1);
if (!tpl) throw new Error("нет шаблона unclassified");

const seg = (start: number, end: number, speakerId: string, text: string): TranscriptSegment => ({ start, end, speakerId, text });
const SEGMENTS: TranscriptSegment[] = [
  seg(0, 9, "speaker_0", "Коллеги, всем добрый день. Давайте пройдёмся по статусу кампании Nomad Cold Brew за первые две недели."),
  seg(9, 21, "speaker_1", "Да, Асель, спасибо. Со стороны бренда главное — у нас сдвигается дата поставки в сети, теперь это восьмое октября, а не первое."),
  seg(21, 30, "speaker_0", "Поняла, значит, наружку в бизнес-центрах сдвигаем на неделю, чтобы не рекламировать то, чего нет на полке."),
  seg(30, 44, "speaker_2", "Согласен. И ещё, Данияр просил передать: по диджиталу хотим видеть отчёт по охвату не раз в месяц, а каждые две недели."),
  seg(44, 52, "speaker_3", "Да, это я. Нам нужно понимать, как идёт знание продукта, пока запуск не набрал обороты."),
  seg(52, 66, "speaker_0", "Хорошо, раз в две недели — сделаем, Ерлан подготовит первый срез к пятнице. Айгерим, по продакшену роликов есть вопросы?"),
  seg(66, 80, "speaker_1", "Есть один: нам нужны версии на казахском для регионов, в брифе это не было. Бюджет на адаптацию согласуем отдельно."),
  seg(80, 92, "speaker_2", "И давайте зафиксируем следующую встречу — двадцать девятого сентября, у нас в офисе, обсудим медиаплан на октябрь."),
  seg(92, 100, "speaker_0", "Записала: двадцать девятое, ваш офис. Тогда по итогам: перенос наружки, отчёт раз в две недели, казахские версии — уточняем бюджет."),
];
const suggestions: SpeakerSuggestions = {
  estimatedSpeakerCount: 3,
  speakers: [
    { speakerId: "speaker_0", name: "Асель", role: "Аккаунт-директор", company: "Orbita Media", side: "ours", confidence: "high", evidence: "«Да, Асель, спасибо» — к ней обращаются, ведёт встречу от агентства", sameAs: null },
    { speakerId: "speaker_1", name: "Айгерим", role: "Бренд-менеджер", company: "Nomad Coffee", side: "client", confidence: "high", evidence: "«Айгерим, по продакшену роликов есть вопросы?» — отвечает про бренд и поставки", sameAs: null },
    { speakerId: "speaker_2", name: "Данияр", role: "Директор по маркетингу", company: "Nomad Coffee", side: "client", confidence: "medium", evidence: "Говорит от лица клиента, назначает встречу «у нас в офисе»", sameAs: null },
    { speakerId: "speaker_3", name: null, role: null, company: null, side: "client", confidence: "low", evidence: "«Да, это я» сразу после упоминания Данияра — похоже, тот же человек, диаризация разделила", sameAs: "speaker_2" },
  ],
  notes: "Четыре метки диаризации, но говорящих, судя по репликам, трое: speaker_3 — продолжение реплик Данияра.",
  model: "demo",
  createdAt: new Date().toISOString(),
};

const startedAt = new Date(Date.UTC(2026, 8, 22, 5, 15)); // 22.09.2026 10:15 Алматы
const durationSec = 1120;
const [m] = await d
  .insert(meetings)
  .values({
    ownerId: owner.id,
    agencyId: "orbita",
    templateId: tpl.id,
    templateCode: tpl.code,
    templateVersion: tpl.version,
    title: "Запись 22.09.2026, 10:15",
    status: "transcribed",
    statusDetail: "Расшифровка готова — проверьте спикеров и выберите тип встречи",
    startedAt,
    endedAt: new Date(startedAt.getTime() + durationSec * 1000),
    durationSec,
    languageHint: null,
    platform: null,
    segmentCount: 4,
    createdAt: startedAt,
  })
  .returning();
await d.insert(transcripts).values({
  meetingId: m!.id,
  provider: "elevenlabs",
  providerRequestId: "demo-guide",
  languageCode: "ru",
  languageProbability: "0.9900",
  fullText: SEGMENTS.map((s) => s.text).join(" "),
  segments: SEGMENTS,
  speakers: {},
  selfSpeakerId: null,
  speakerRoles: {},
  speakerSuggestions: suggestions,
  speakersConfirmedAt: null,
  audioDurationSec: String(durationSec),
  wordCount: SEGMENTS.reduce((n, s) => n + s.text.split(/\s+/).length, 0),
  costUsd: "0.0684",
  createdAt: new Date(startedAt.getTime() + durationSec * 1000 + 180_000),
});
console.log(`встреча «Расшифровка готова» добавлена: ${m!.id}; удалено тестовых: ${junk.length}`);
await closeDb();
