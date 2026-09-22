/**
 * Демо-данные для скриншотов и презентаций: пользователь, колллеги, клиентский бриф с эталонным транскриптом
 * (4 спикера, роли, владелец записи) и отчётом по шаблону «Брифинг от клиента», задачи, ещё три встречи для
 * списка и вкладки задач. Все имена и бренды вымышленные. Повторный запуск пересоздаёт данные.
 *   pnpm --filter @lakonik/server exec tsx --env-file=.env scripts/seed-showcase.ts [email]
 * Вход в приложение — по коду на этот email (локально без RESEND_API_KEY код печатается в лог API).
 */
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { closeDb, db } from "../src/db/client.js";
import { agencies, meetingTemplates, meetings, reports, tasks, transcripts, user } from "../src/db/schema/index.js";
import type { ActionItem, DecisionItem, Participant, ReportSection, TranscriptSegment } from "../src/db/types.js";
import { renderMarkdown } from "../src/export/markdown.js";
import { syncReportActionItems, syncTasksFromReport } from "../src/tasks/service.js";

const email = process.argv[2] ?? "asel.nurlanova@orbita.kz";
const AGENCY = { id: "orbita", name: "Orbita Media", emailDomains: ["orbita.kz"] };
const COLLEAGUES = [
  { name: "Ерлан Сапаров", email: "erlan.saparov@orbita.kz" },
  { name: "Мадина Касымова", email: "madina.kassymova@orbita.kz" },
  { name: "Тимур Ахметов", email: "timur.akhmetov@orbita.kz" },
];

/** 15.09.2026 в Алматы (UTC+5) */
const at = (day: number, hh: number, mm = 0) => new Date(Date.UTC(2026, 8, day, hh - 5, mm));

const d = db();

async function template(code: string) {
  const [t] = await d.select().from(meetingTemplates).where(and(eq(meetingTemplates.code, code), eq(meetingTemplates.isActive, true))).limit(1);
  if (!t) throw new Error(`Шаблон ${code} не найден — сначала pnpm db:seed`);
  return t;
}

async function ensureUser(name: string, mail: string, role = "member") {
  const [existing] = await d.select().from(user).where(eq(user.email, mail)).limit(1);
  if (existing) {
    await d.update(user).set({ name, agencyId: AGENCY.id, role }).where(eq(user.id, existing.id));
    return existing.id;
  }
  const id = randomUUID();
  await d.insert(user).values({ id, name, email: mail, emailVerified: true, agencyId: AGENCY.id, role });
  return id;
}

// --- Транскрипт клиентского брифа -------------------------------------------------------------------------

const SPEAKERS = { speaker_0: "Асель Нурланова", speaker_1: "Айгерим Бекова", speaker_2: "Данияр Оспанов", speaker_3: "Ерлан Сапаров" };
const ROLES = { speaker_0: "ours", speaker_1: "client", speaker_2: "client", speaker_3: "ours" } as const;

const seg = (start: number, end: number, speakerId: keyof typeof SPEAKERS, text: string): TranscriptSegment => ({ start, end, speakerId, text });
const SEGMENTS: TranscriptSegment[] = [
  seg(0, 9, "speaker_0", "Айгерим, Данияр, спасибо, что приехали. Предлагаю так: вы рассказываете про задачу, мы с Ерланом задаём вопросы, и в конце фиксируем сроки."),
  seg(9, 31, "speaker_1", "Да, давайте. Мы запускаем новую линейку — Nomad Cold Brew, холодный кофе в банках 0,33. Три вкуса: классический, с молоком и с апельсином. Продукт уже в производстве, первые партии будут в апреле."),
  seg(31, 49, "speaker_2", "Главная задача — знание. Сейчас про Nomad знают как про кофейни, а про готовый кофе в рознице — почти никто. Нам нужно, чтобы к концу лета cold brew ассоциировался с нами, а не с федеральными брендами."),
  seg(49, 58, "speaker_3", "А если говорить про аудиторию — кто покупает такой продукт? Есть данные с фокус-групп?"),
  seg(58, 82, "speaker_1", "Да, проводили в июле. Ядро — двадцать–тридцать лет, Алматы, Астана, Шымкент. Офисные сотрудники и студенты, те, кто берёт кофе навынос по дороге. Им важны скорость и вкус, цена — на втором месте. Отчёт по фокус-группам пришлю вместе с брендбуком."),
  seg(82, 95, "speaker_0", "Отлично, это сильно поможет. По срокам: когда хотите быть на полке и когда старт коммуникации?"),
  seg(95, 112, "speaker_2", "На полке — с первого июня. Коммуникацию хотим начать чуть раньше, тизером, где-то с середины мая. Основной флайт — июнь и июль, август — поддержка."),
  seg(112, 125, "speaker_3", "По каналам есть предпочтения? Или мы предлагаем микс сами?"),
  seg(125, 151, "speaker_2", "Мы точно хотим диджитал — соцсети, блогеры, видео. И наружку у бизнес-центров и университетов, там наша аудитория. Телевизор не рассматриваем. Если предложите что-то нестандартное вроде дегустаций у офисов — обсудим."),
  seg(151, 167, "speaker_1", "И важный момент — нам нужен локальный инсайт. Мы не хотим выглядеть как копия глобальных брендов. Хочется, чтобы кампания говорила с казахстанской аудиторией на её языке."),
  seg(167, 178, "speaker_0", "Поняла. Нужна ли казахоязычная версия ролика или адаптация ключевого сообщения?"),
  seg(178, 187, "speaker_1", "Скорее всего да, но это надо подтвердить с руководством. Вернусь с ответом на неделе."),
  seg(187, 199, "speaker_3", "По бюджету — можете обозначить порядок, чтобы мы не предлагали лишнего?"),
  seg(199, 218, "speaker_2", "На медиа — сорок пять миллионов тенге на весь флайт. Продакшн считаем отдельно, там цифру пока не назову, нужно согласовать с финансовым директором. По диджитал-части бюджет подтвержу до пятницы."),
  seg(218, 230, "speaker_0", "Хорошо. По ограничениям: что точно нельзя, что важно по тону?"),
  seg(230, 252, "speaker_1", "Нельзя делать акцент на «энергии» и бодрости, как у энергетиков — юристы против. Тон — лёгкий, дружелюбный, без пафоса. И никаких прямых сравнений с конкурентами."),
  seg(730, 752, "speaker_3", "Тогда предлагаю такой ход: мы готовим стратегическую рамку и три территории коммуникации, одна из них — строго на локальном инсайте. Показываем через полторы недели."),
  seg(752, 761, "speaker_2", "Полторы недели — нормально. Давайте двадцать пятого сентября, у нас в офисе."),
  seg(761, 772, "speaker_0", "Двадцать пятое, у вас. До этого я отправлю контакт-репорт и список уточняющих вопросов — завтра к обеду."),
  seg(1100, 1119, "speaker_1", "Ещё одно. KPI по знанию бренда мы пока не считали — есть только продажи. Если предложите, как измерять знание, будет здорово."),
  seg(1119, 1130, "speaker_3", "Предложим: замер до и после кампании плюс brand lift в соцсетях. Включим в стратегию."),
  seg(1390, 1408, "speaker_2", "Итого: старт тизера — середина мая, запуск — первое июня, медиа — сорок пять миллионов, каналы — диджитал и наружка. Презентация — двадцать пятого. Всё верно?"),
  seg(1408, 1416, "speaker_0", "Всё верно. Со своей стороны ждём брендбук, отчёт по фокус-группам и подтверждение бюджета на диджитал."),
  seg(1416, 1424, "speaker_1", "Брендбук и фокус-группы отправлю до четверга."),
  seg(1424, 1432, "speaker_2", "Спасибо, коллеги. До встречи двадцать пятого."),
];

// --- Отчёт по шаблону «Брифинг от клиента» -------------------------------------------------------------------

const SUMMARY =
  "Nomad Coffee запускает линейку холодного кофе в банках Nomad Cold Brew (три вкуса) с 1 июня 2027. Задача кампании — построить знание продукта в рознице среди аудитории 20–30 лет в Алматы, Астане и Шымкенте. Медиабюджет — 45 млн ₸, каналы — диджитал и наружная реклама, тизер с середины мая. Агентство презентует стратегию и три территории коммуникации 25 сентября.";

const PARTICIPANTS: Participant[] = [
  { name: "Данияр Оспанов", role: "директор по маркетингу, утвердил бриф", company: "Nomad Coffee", side: "client" },
  { name: "Айгерим Бекова", role: "бренд-менеджер", company: "Nomad Coffee", side: "client" },
  { name: "Асель Нурланова", role: "аккаунт-директор", company: AGENCY.name, side: "ours" },
  { name: "Ерлан Сапаров", role: "стратег", company: AGENCY.name, side: "ours" },
];

const SECTIONS: Array<Pick<ReportSection, "key" | "content">> = [
  { key: "summary", content: SUMMARY },
  {
    key: "brief",
    content: [
      "**Продукт / бренд:** Nomad Cold Brew — холодный кофе в банках 0,33 л, три вкуса: классический, с молоком, с апельсином. Первые партии — апрель 2027.",
      "**Цель кампании:** знание продукта в рознице; к концу лета cold brew должен ассоциироваться с Nomad, а не с федеральными брендами.",
      "**Целевая аудитория:** 20–30 лет, Алматы, Астана, Шымкент; офисные сотрудники и студенты, берут кофе навынос; важны скорость и вкус, цена вторична (фокус-группы, июль 2026).",
      "**Бюджет:** медиа — 45 млн ₸ на весь флайт; продакшн — не озвучено, уточнить (согласуется с финансовым директором).",
      "**Сроки:** тизер — с середины мая 2027; на полке и старт основного флайта — 1 июня; июнь–июль — основной флайт, август — поддержка.",
      "**Каналы:** диджитал (соцсети, блогеры, видео) и наружная реклама у бизнес-центров и университетов; ТВ не рассматривается; открыты к нестандартным форматам (дегустации у офисов).",
      "**KPI:** продажи; знание бренда клиент не измерял — агентство предложит замер до/после кампании и brand lift в соцсетях.",
      "**Ограничения:** без акцента на «энергии» и бодрости (позиция юристов), без прямых сравнений с конкурентами; тон — лёгкий, дружелюбный, без пафоса; обязателен локальный инсайт.",
    ].join("\n"),
  },
  {
    key: "internal_comments",
    content:
      "Бриф утверждён на уровне директора по маркетингу — можно стартовать без дополнительных согласований. Риск: продакшн-бюджет не определён, а клиент ждёт видео — закладываем два сценария (полноценный ролик и UGC-формат). Локальный инсайт — главный критерий оценки, стоит подключить казахоязычного копирайтера уже на этапе территорий.",
  },
  {
    key: "response_deadline",
    content: "25 сентября 2026 — презентация стратегии и трёх территорий коммуникации в офисе Nomad Coffee. Контакт-репорт и список уточняющих вопросов — 16 сентября до 13:00.",
  },
];

const ACTION_ITEMS: ActionItem[] = [
  { assignee: "Асель Нурланова", task: "Отправить клиенту контакт-репорт и список уточняющих вопросов", deadline: "16 сентября, до 13:00", deadlineDate: "2026-09-16", quote: "До этого я отправлю контакт-репорт и список уточняющих вопросов — завтра к обеду." },
  { assignee: "Айгерим Бекова", task: "Прислать брендбук и отчёт по фокус-группам", deadline: "до четверга, 17 сентября", deadlineDate: "2026-09-17", quote: "Брендбук и фокус-группы отправлю до четверга." },
  { assignee: "Данияр Оспанов", task: "Подтвердить бюджет на диджитал-часть кампании", deadline: "до пятницы, 18 сентября", deadlineDate: "2026-09-18", quote: "По диджитал-части бюджет подтвержу до пятницы." },
  { assignee: "Айгерим Бекова", task: "Подтвердить, нужна ли казахоязычная версия ролика", deadline: "на этой неделе", deadlineDate: "2026-09-18", quote: "Скорее всего да, но это надо подтвердить с руководством. Вернусь с ответом на неделе." },
  { assignee: "Ерлан Сапаров", task: "Подготовить стратегическую рамку и три территории коммуникации, одна — на локальном инсайте", deadline: "к презентации 25 сентября", deadlineDate: "2026-09-25", quote: "Мы готовим стратегическую рамку и три территории коммуникации, одна из них — строго на локальном инсайте." },
  { assignee: "Ерлан Сапаров", task: "Предложить методику измерения знания бренда: замер до/после кампании и brand lift в соцсетях", deadline: "к презентации 25 сентября", deadlineDate: "2026-09-25", quote: "Предложим: замер до и после кампании плюс brand lift в соцсетях." },
  { assignee: "Асель Нурланова", task: "Уточнить бюджет на продакшн после согласования с финансовым директором клиента", deadline: null, deadlineDate: null, quote: "Продакшн считаем отдельно, там цифру пока не назову, нужно согласовать с финансовым директором." },
];

const DECISIONS: DecisionItem[] = [
  { decision: "Запуск на полке и старт основного флайта — 1 июня 2027; тизер — с середины мая", owner: "Данияр Оспанов", deadline: "1 июня 2027" },
  { decision: "Медиабюджет — 45 млн ₸ на весь флайт (июнь–август)", owner: "Данияр Оспанов", deadline: null },
  { decision: "Каналы: диджитал (соцсети, блогеры, видео) и наружная реклама у БЦ и вузов; ТВ исключён", owner: null, deadline: null },
  { decision: "Презентация стратегии — 25 сентября в офисе Nomad Coffee", owner: "Асель Нурланова", deadline: "25 сентября 2026" },
];

const OPEN_QUESTIONS = [
  "Бюджет на продакшн: порядок суммы и когда будет согласован с финансовым директором?",
  "Нужна ли казахоязычная версия ролика или достаточно адаптации ключевого сообщения?",
  "KPI по знанию бренда: подходит ли клиенту замер до/после кампании и brand lift в соцсетях?",
  "Есть ли ограничения юристов по промо-механикам, например дегустациям у офисов?",
];
const CLIENT_REQUESTS = [
  "Три территории коммуникации, одна — строго на локальном инсайте",
  "Рассмотреть нестандартные форматы: дегустации у бизнес-центров",
  "Не копировать стилистику глобальных кофейных брендов",
];
const MISSING_INFO = ["Бюджет на продакшн", "Точное время презентации 25 сентября", "Целевые значения KPI по знанию бренда"];

// --- Вставка --------------------------------------------------------------------------------------------------

async function insertReport(meeting: typeof meetings.$inferSelect, tpl: typeof meetingTemplates.$inferSelect, data: {
  title: string; summary: string; participants: Participant[]; sections: Array<Pick<ReportSection, "key" | "content">>; actionItems: ActionItem[];
  decisions?: DecisionItem[]; openQuestions?: string[]; clientRequests?: string[]; missingInfo?: string[]; nextMeeting?: { when: string | null; format: string | null; agenda: string | null } | null;
}) {
  const base = {
    meetingId: meeting.id,
    version: 1,
    templateId: tpl.id,
    templateCode: tpl.code,
    templateVersion: tpl.version,
    model: "claude-opus-5",
    effort: "high",
    title: data.title,
    summary: data.summary,
    participants: data.participants,
    sections: data.sections.map((s) => {
      const ts = tpl.reportSections.find((x) => x.key === s.key);
      return { key: s.key, heading: ts?.heading ?? s.key, content: s.content, internalOnly: ts?.internalOnly ?? false };
    }),
    actionItems: data.actionItems.map((a) => ({ ...a, done: false })),
    decisions: data.decisions ?? [],
    openQuestions: data.openQuestions ?? [],
    clientRequests: data.clientRequests ?? [],
    missingInfo: data.missingInfo ?? [],
    nextMeeting: data.nextMeeting ?? null,
    markdown: "",
    inputTokens: 21400,
    outputTokens: 2900,
    cacheReadTokens: 6200,
    costUsd: "0.3100",
    createdBy: "pipeline",
    isCurrent: true,
    instructions: null,
  };
  const markdown = renderMarkdown(tpl, { ...base, id: "", createdAt: meeting.endedAt ?? new Date(), updatedAt: new Date(), editedAt: null, editedBy: null } as unknown as typeof reports.$inferSelect, {
    startedAt: meeting.startedAt,
    durationSec: meeting.durationSec,
    platform: meeting.platform,
    templateTitle: tpl.title,
    confidentiality: meeting.confidentiality,
    includeInternal: true,
  });
  const [inserted] = await d.insert(reports).values({ ...base, markdown, createdAt: meeting.endedAt ?? new Date() }).returning();
  await syncTasksFromReport(meeting, inserted!, base.actionItems);
  await syncReportActionItems(meeting.id);
  return inserted!;
}

async function insertMeeting(ownerId: string, tpl: typeof meetingTemplates.$inferSelect, v: {
  title: string; startedAt: Date; durationSec: number; platform: string; contextFields?: Record<string, string>; participantsHint?: Participant[]; numSpeakersHint?: number; confidentiality?: "standard" | "restricted";
}) {
  const [m] = await d
    .insert(meetings)
    .values({
      ownerId,
      agencyId: AGENCY.id,
      templateId: tpl.id,
      templateCode: tpl.code,
      templateVersion: tpl.version,
      title: v.title,
      status: "done",
      startedAt: v.startedAt,
      endedAt: new Date(v.startedAt.getTime() + v.durationSec * 1000),
      durationSec: v.durationSec,
      contextFields: v.contextFields ?? {},
      participantsHint: v.participantsHint ?? [],
      numSpeakersHint: v.numSpeakersHint ?? null,
      languageHint: "ru",
      platform: v.platform,
      confidentiality: v.confidentiality ?? "standard",
      segmentCount: Math.ceil(v.durationSec / 300),
      createdAt: v.startedAt,
    })
    .returning();
  return m!;
}

await d.insert(agencies).values({ ...AGENCY, keyterms: ["Nomad Coffee", "cold brew", "Orbita"] }).onConflictDoUpdate({ target: agencies.id, set: { name: AGENCY.name, emailDomains: AGENCY.emailDomains } });
const ownerId = await ensureUser("Асель Нурланова", email);
for (const c of COLLEAGUES) await ensureUser(c.name, c.email);

// Пересоздание: все встречи демо-пользователя (транскрипты, отчёты, задачи удаляются каскадом)
const old = await d.select({ id: meetings.id }).from(meetings).where(eq(meetings.ownerId, ownerId));
if (old.length) await d.delete(meetings).where(inArray(meetings.id, old.map((m) => m.id)));

// 1. Клиентский бриф — главная демо-встреча
const brief = await insertMeeting(ownerId, await template("client_brief"), {
  title: "Nomad Cold Brew — бриф на запуск, лето 2027",
  startedAt: at(15, 11, 0),
  durationSec: 1432,
  platform: "Офис клиента",
  contextFields: { campaign: "Запуск Nomad Cold Brew", product: "Nomad Cold Brew — холодный кофе в банках", channels: "диджитал, наружная реклама" },
  participantsHint: PARTICIPANTS,
  numSpeakersHint: 4,
});
await d.insert(transcripts).values({
  meetingId: brief.id,
  provider: "elevenlabs",
  providerRequestId: "demo",
  languageCode: "ru",
  languageProbability: "0.9900",
  fullText: SEGMENTS.map((s) => s.text).join(" "),
  segments: SEGMENTS,
  speakers: SPEAKERS,
  selfSpeakerId: "speaker_0",
  speakerRoles: ROLES,
  audioDurationSec: "1432.000",
  wordCount: SEGMENTS.reduce((n, s) => n + s.text.split(/\s+/).length, 0),
  costUsd: "0.0875",
  createdAt: at(15, 11, 27),
});
await insertReport(brief, await template("client_brief"), {
  title: "Бриф: запуск Nomad Cold Brew — лето 2027",
  summary: SUMMARY,
  participants: PARTICIPANTS,
  sections: SECTIONS,
  actionItems: ACTION_ITEMS,
  decisions: DECISIONS,
  openQuestions: OPEN_QUESTIONS,
  clientRequests: CLIENT_REQUESTS,
  missingInfo: MISSING_INFO,
  nextMeeting: { when: "25 сентября 2026", format: "очно, офис Nomad Coffee", agenda: "Презентация стратегии и трёх территорий коммуникации" },
});

// 2–4. Встречи для списка и вкладки задач
const status = await insertMeeting(ownerId, await template("internal_status"), {
  title: "Nomad Cold Brew: статус подготовки стратегии",
  startedAt: at(14, 15, 0),
  durationSec: 1085,
  platform: "Офис",
});
const statusReport = await insertReport(status, await template("internal_status"), {
  title: "Статус: подготовка стратегии Nomad Cold Brew",
  summary: "Команда синхронизировалась по подготовке к презентации 25 сентября: бенчмарки, медиасплит и территории коммуникации распределены по ответственным.",
  participants: [
    { name: "Асель Нурланова", role: "аккаунт-директор", company: AGENCY.name, side: "ours" },
    { name: "Ерлан Сапаров", role: "стратег", company: AGENCY.name, side: "ours" },
    { name: "Мадина Касымова", role: "старший аналитик", company: AGENCY.name, side: "ours" },
    { name: "Тимур Ахметов", role: "медиапланер", company: AGENCY.name, side: "ours" },
  ],
  sections: [{ key: "summary", content: "Подготовка идёт по плану, блокеров нет. Ключевой риск — отсутствие продакшн-бюджета у клиента." }],
  actionItems: [
    { assignee: "Мадина Касымова", task: "Собрать бенчмарки запусков cold brew на рынках СНГ", deadline: "18 сентября", deadlineDate: "2026-09-18", quote: null },
    { assignee: "Тимур Ахметов", task: "Подготовить медиасплит диджитал / наружная реклама на 45 млн ₸", deadline: "22 сентября", deadlineDate: "2026-09-22", quote: null },
  ],
});
await d.update(tasks).set({ status: "done" }).where(and(eq(tasks.reportId, statusReport.id), eq(tasks.assigneeName, "Мадина Касымова")));

const vendor = await insertMeeting(ownerId, await template("vendor_negotiation"), {
  title: "Продакшн «Кадр»: условия съёмки ролика",
  startedAt: at(11, 12, 0),
  durationSec: 2460,
  platform: "Видеозвонок",
});
await insertReport(vendor, await template("vendor_negotiation"), {
  title: "Переговоры с продакшном «Кадр»: условия съёмки",
  summary: "Обсудили смету и сроки съёмки ролика: продакшн готов сократить съёмочный день до одного при упрощении локаций.",
  participants: [
    { name: "Асель Нурланова", role: "аккаунт-директор", company: AGENCY.name, side: "ours" },
    { name: "Руслан Жаксыбеков", role: "продюсер", company: "Продакшн «Кадр»", side: "vendor" },
  ],
  sections: [{ key: "summary", content: "Продакшн предлагает две конфигурации сметы; финальное решение после подтверждения бюджета клиентом." }],
  actionItems: [{ assignee: "Асель Нурланова", task: "Получить обновлённую смету от продакшна «Кадр» в двух конфигурациях", deadline: "16 сентября", deadlineDate: "2026-09-16", quote: null }],
});

const intro = await insertMeeting(ownerId, await template("client_intro"), {
  title: "Знакомство: сеть фитнес-клубов Pulse",
  startedAt: at(9, 10, 30),
  durationSec: 1980,
  platform: "Офис клиента",
});
await insertReport(intro, await template("client_intro"), {
  title: "Знакомство с сетью фитнес-клубов Pulse",
  summary: "Первая встреча с маркетингом сети Pulse: планируют ребрендинг и запуск абонементов для корпоративных клиентов, ищут агентство на годовое обслуживание.",
  participants: [
    { name: "Асель Нурланова", role: "аккаунт-директор", company: AGENCY.name, side: "ours" },
    { name: "Ерлан Сапаров", role: "стратег", company: AGENCY.name, side: "ours" },
    { name: "Алия Сериккызы", role: "директор по маркетингу", company: "Pulse", side: "client" },
  ],
  sections: [{ key: "summary", content: "Клиент открыт к сотрудничеству; ждёт кредо агентства и релевантные кейсы до конца следующей недели." }],
  actionItems: [{ assignee: "Ерлан Сапаров", task: "Подготовить кредо агентства и кейсы для Pulse", deadline: "19 сентября", deadlineDate: "2026-09-19", quote: null }],
});

// 5. Встреча в обработке — сценарий «встреча закончилась, отчёт через несколько минут»
const processing = await insertMeeting(ownerId, await template("internal_brief"), {
  title: "Запись 15.09.2026, 14:20 · Внутренний брифинг команды",
  startedAt: at(15, 14, 20),
  durationSec: 1275,
  platform: "Офис",
});
await d.update(meetings).set({ status: "summarizing", statusDetail: "Составление отчёта", updatedAt: new Date() }).where(eq(meetings.id, processing.id));

console.log(`демо-данные готовы: ${email} → встречи ${[brief, status, vendor, intro, processing].length}, главная: ${brief.id}`);
await closeDb();
