/**
 * Тарифы и лимиты (раздел 8 docs/lakonik-1.0.md). Сервер — источник истины: клиент показывает
 * paywall по этим же числам, но решение «можно / нельзя» принимается здесь.
 */

/** Уровни подписки, которые продаются в App Store */
export const PAID_TIERS = ["starter", "pro", "unlimited"] as const;
export type PaidTier = (typeof PAID_TIERS)[number];
/** Полный набор уровней: free — без подписки, enterprise — план организации */
export type Tier = "free" | PaidTier | "enterprise";

export interface TierLimits {
  /** Максимальная длительность одной записи, секунды */
  maxRecordingSec: number;
  /** Часы в месяц, секунды; null — без ограничения */
  monthlyLimitSec: number | null;
  /** Записей в календарный день; null — без ограничения */
  dailyRecordings: number | null;
  /** Запись онлайн-встречи (трансляция экрана) */
  onlineMeetings: boolean;
  /** Модель отчёта: draft — быстрая (ANTHROPIC_MODEL_DRAFT), full — основная (ANTHROPIC_MODEL) */
  model: "draft" | "full";
}

const HOUR = 3600;

/**
 * Лимиты уровней. Для enterprise месячный пул считается отдельно: 20 часов на место организации
 * (см. ENTERPRISE_SEAT_SEC), поэтому здесь monthlyLimitSec = null.
 */
export const TIER_LIMITS: Record<Tier, TierLimits> = {
  free: { maxRecordingSec: 5 * 60, monthlyLimitSec: null, dailyRecordings: 5, onlineMeetings: false, model: "draft" },
  starter: { maxRecordingSec: HOUR, monthlyLimitSec: 5 * HOUR, dailyRecordings: null, onlineMeetings: false, model: "draft" },
  pro: { maxRecordingSec: 3 * HOUR, monthlyLimitSec: 15 * HOUR, dailyRecordings: null, onlineMeetings: true, model: "full" },
  // Безлимит: 40 ч — мягкий потолок fair use
  unlimited: { maxRecordingSec: 5 * HOUR, monthlyLimitSec: 40 * HOUR, dailyRecordings: null, onlineMeetings: true, model: "full" },
  enterprise: { maxRecordingSec: 5 * HOUR, monthlyLimitSec: null, dailyRecordings: null, onlineMeetings: true, model: "full" },
};

/** Пул часов enterprise: 20 часов в месяц на каждое оплаченное место организации */
export const ENTERPRISE_SEAT_SEC = 20 * HOUR;

/** Порядок уровней: выше — «сильнее». Используется при выборе активной подписки. */
export const TIER_RANK: Record<Tier, number> = { free: 0, starter: 1, pro: 2, unlimited: 3, enterprise: 4 };

/** Запись длиннее лимита допускается на 10 % — клиент сам останавливает запись на границе */
export const DURATION_TOLERANCE = 1.1;

/** Product ID подписок App Store и ручные подписки (тесты и компенсации, выдаются через scripts/admin.ts) */
export const PRODUCT_IDS: Record<PaidTier, string[]> = {
  starter: ["lakonik.starter.monthly", "lakonik.starter.yearly", "manual.starter"],
  pro: ["lakonik.pro.monthly", "lakonik.pro.yearly", "manual.pro"],
  unlimited: ["lakonik.unlimited.monthly", "lakonik.unlimited.yearly", "manual.unlimited"],
};

/** Уровень по идентификатору продукта; null — чужой или неизвестный продукт */
export function tierForProduct(productId: string | null | undefined): PaidTier | null {
  if (!productId) return null;
  const id = productId.trim();
  for (const tier of PAID_TIERS) if (PRODUCT_IDS[tier].includes(id)) return tier;
  return null;
}

/** Период подписки по идентификатору продукта — для аналитики */
export function periodForProduct(productId: string | null | undefined): "monthly" | "yearly" | "manual" | null {
  if (!productId) return null;
  if (productId.startsWith("manual.")) return "manual";
  if (productId.endsWith(".yearly")) return "yearly";
  if (productId.endsWith(".monthly")) return "monthly";
  return null;
}

/** Лимиты уровня; для enterprise месячный пул зависит от числа мест организации */
export function limitsFor(tier: Tier, planSeats?: number | null): TierLimits {
  const base = TIER_LIMITS[tier];
  if (tier !== "enterprise") return base;
  return { ...base, monthlyLimitSec: Math.max(1, planSeats ?? 1) * ENTERPRISE_SEAT_SEC };
}

/** Название уровня для писем и сообщений об ошибках */
export const TIER_TITLES: Record<Tier, string> = {
  free: "Free",
  starter: "Starter",
  pro: "Pro",
  unlimited: "Безлимит",
  enterprise: "Enterprise",
};
