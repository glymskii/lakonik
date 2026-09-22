import { HTTPException } from "hono/http-exception";
import { track } from "../analytics/amplitude.js";
import { DURATION_TOLERANCE, TIER_TITLES, type Tier, type TierLimits } from "./tiers.js";
import { entitlementFor, type Entitlement, type OrgScope } from "./entitlement.js";

/**
 * Проверка квот. Ошибка — HTTP 402 с телом { error, code, limit, used, resetsAt }: клиент открывает
 * по ней экран тарифа. Тексты — для пользователя, на русском.
 */

export type QuotaCode = "quota.daily" | "quota.duration" | "quota.monthly" | "feature.online_meetings";

export interface QuotaErrorBody {
  error: string;
  code: QuotaCode;
  limit: number | null;
  used: number | null;
  resetsAt: string | null;
}

/** 402 с кодом квоты: onError в api/app.ts отдаёт готовый JSON как есть */
export function quotaError(userId: string, body: QuotaErrorBody): HTTPException {
  track(userId, "quota_hit", { code: body.code });
  return new HTTPException(402, { message: body.error, res: Response.json(body, { status: 402 }) });
}

const hours = (sec: number): string => {
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  if (h && m) return `${h} ч ${m} мин`;
  if (h) return `${h} ч`;
  return `${m} мин`;
};

/** Человеческая длительность лимита записи: «5 минут», «1 час», «3 часа» */
function recordingLimitText(sec: number): string {
  if (sec < 3600) return `${Math.round(sec / 60)} мин`;
  const h = sec / 3600;
  const word = h === 1 ? "час" : h < 5 ? "часа" : "часов";
  return `${h} ${word}`;
}

/** Подсказка «что делать» под текстом ошибки */
function upgradeHint(tier: Tier, source: Entitlement["source"]): string {
  if (source === "enterprise") return "Обратитесь к администратору организации — он может увеличить число мест.";
  if (tier === "unlimited") return "Это мягкий предел честного использования — напишите нам, если часы нужны регулярно.";
  return "Откройте «Тариф» и выберите подходящий план.";
}

export interface QuotaContext {
  userId: string;
  org: OrgScope | null;
  timezone?: string | null;
}

/**
 * Можно ли начать запись или импорт. Проверяет онлайн-встречи, дневной лимит и остаток часов.
 * Возвращает entitlement — вызывающий код может использовать его дальше без повторного запроса.
 */
export async function assertCanCreateMeeting(ctx: QuotaContext, opts: { online?: boolean } = {}): Promise<Entitlement> {
  const ent = await entitlementFor({ userId: ctx.userId, org: ctx.org, timezone: ctx.timezone });
  const { limits, usage } = ent;

  if (opts.online && !limits.onlineMeetings) {
    throw quotaError(ctx.userId, {
      error: `Запись онлайн-встреч доступна с тарифа Pro. Сейчас у вас ${TIER_TITLES[ent.tier]}. ${upgradeHint(ent.tier, ent.source)}`,
      code: "feature.online_meetings",
      limit: null,
      used: null,
      resetsAt: null,
    });
  }

  if (limits.dailyRecordings !== null && usage.dailyCount >= limits.dailyRecordings) {
    throw quotaError(ctx.userId, {
      error: `На тарифе ${TIER_TITLES[ent.tier]} доступно ${limits.dailyRecordings} записей в день — лимит на сегодня исчерпан. ${upgradeHint(ent.tier, ent.source)}`,
      code: "quota.daily",
      limit: limits.dailyRecordings,
      used: usage.dailyCount,
      resetsAt: usage.dayResetsAt,
    });
  }

  if (limits.monthlyLimitSec !== null && usage.monthlySec >= limits.monthlyLimitSec) {
    const pool = ent.source === "enterprise" ? "Пул часов организации" : `Часы тарифа ${TIER_TITLES[ent.tier]}`;
    throw quotaError(ctx.userId, {
      error: `${pool} на этот месяц закончились (${hours(limits.monthlyLimitSec)}). Новые записи и импорт будут доступны после ${new Date(usage.monthResetsAt).toLocaleDateString("ru-RU", { day: "numeric", month: "long" })}. ${upgradeHint(ent.tier, ent.source)}`,
      code: "quota.monthly",
      limit: limits.monthlyLimitSec,
      used: usage.monthlySec,
      resetsAt: usage.monthResetsAt,
    });
  }

  return ent;
}

/** Превышена ли максимальная длительность записи (с допуском 10 %) */
export function isOverDuration(durationSec: number | null | undefined, limits: TierLimits): boolean {
  if (!durationSec || durationSec <= 0) return false;
  return durationSec > Math.round(limits.maxRecordingSec * DURATION_TOLERANCE);
}

/** Текст, который увидит пользователь у встречи, переведённой в failed из-за длительности */
export function durationErrorText(durationSec: number, tier: Tier, limits: TierLimits): string {
  return `Запись длиннее ${recordingLimitText(limits.maxRecordingSec)} — предела тарифа ${TIER_TITLES[tier]} (в записи ${hours(durationSec)}). Отчёт по ней не строится. ${upgradeHint(tier, "subscription")}`;
}

/** 402 quota.duration для ответа на finalize */
export function durationQuotaError(userId: string, durationSec: number, tier: Tier, limits: TierLimits): HTTPException {
  return quotaError(userId, {
    error: durationErrorText(durationSec, tier, limits),
    code: "quota.duration",
    limit: limits.maxRecordingSec,
    used: durationSec,
    resetsAt: null,
  });
}
