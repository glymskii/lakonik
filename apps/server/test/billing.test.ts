import { describe, expect, it } from "vitest";
import { isEnterpriseActive, isSubscriptionActive, periodBounds, pickSubscription, resolveTier, resolveTimezone, zonedTimeToUtc, type OrgScope } from "../src/billing/entitlement.js";
import { effectOfNotification, statusFromApple } from "../src/billing/apple.js";
import { isOverDuration } from "../src/billing/quota.js";
import { limitsFor, periodForProduct, tierForProduct, TIER_LIMITS } from "../src/billing/tiers.js";

const sub = (tier: "starter" | "pro" | "unlimited", over: Partial<{ status: "active" | "grace" | "expired" | "revoked"; expiresAt: Date | null; productId: string }> = {}) => ({
  productId: over.productId ?? `lakonik.${tier}.monthly`,
  tier,
  status: over.status ?? ("active" as const),
  expiresAt: over.expiresAt === undefined ? new Date("2026-10-01T00:00:00Z") : over.expiresAt,
  autoRenew: true,
  environment: "Production",
});

const org = (over: Partial<OrgScope> = {}): OrgScope => ({ id: "o1", kind: "team", plan: "free", planSeats: null, planUntil: null, ...over });

const NOW = new Date("2026-09-23T10:00:00Z");

describe("границы дня и месяца по часовому поясу", () => {
  it("Алматы (UTC+5): сутки и месяц начинаются на 5 часов раньше UTC", () => {
    const p = periodBounds(new Date("2026-09-23T10:00:00Z"), "Asia/Almaty");
    expect(p.dayStart.toISOString()).toBe("2026-09-22T19:00:00.000Z");
    expect(p.dayEnd.toISOString()).toBe("2026-09-23T19:00:00.000Z");
    expect(p.monthStart.toISOString()).toBe("2026-08-31T19:00:00.000Z");
    expect(p.monthEnd.toISOString()).toBe("2026-09-30T19:00:00.000Z");
  });

  it("местная полночь и конец месяца определяются по поясу, а не по UTC", () => {
    // 23:30 по Алматы 30 сентября — это ещё сентябрь, хотя в UTC уже 18:30 того же дня
    const p = periodBounds(new Date("2026-09-30T18:30:00Z"), "Asia/Almaty");
    expect(p.monthEnd.toISOString()).toBe("2026-09-30T19:00:00.000Z");
    // 01:00 по Алматы 1 октября — уже октябрь
    const next = periodBounds(new Date("2026-09-30T20:00:00Z"), "Asia/Almaty");
    expect(next.monthStart.toISOString()).toBe("2026-09-30T19:00:00.000Z");
    expect(next.monthEnd.toISOString()).toBe("2026-10-31T19:00:00.000Z");
  });

  it("UTC и западные пояса", () => {
    const utc = periodBounds(new Date("2026-09-23T10:00:00Z"), "UTC");
    expect(utc.dayStart.toISOString()).toBe("2026-09-23T00:00:00.000Z");
    expect(utc.monthEnd.toISOString()).toBe("2026-10-01T00:00:00.000Z");
    // Нью-Йорк в сентябре — UTC−4 (летнее время)
    const ny = periodBounds(new Date("2026-09-23T10:00:00Z"), "America/New_York");
    expect(ny.dayStart.toISOString()).toBe("2026-09-23T04:00:00.000Z");
  });

  it("переход на зимнее время не сдвигает границу суток", () => {
    // В Европе/Берлине 25.10.2026 час сдвигается назад: 1 ноября всё равно начинается в 23:00 UTC 31 октября
    const p = periodBounds(new Date("2026-11-05T12:00:00Z"), "Europe/Berlin");
    expect(p.monthStart.toISOString()).toBe("2026-10-31T23:00:00.000Z");
    expect(zonedTimeToUtc("Europe/Berlin", 2026, 7, 1).toISOString()).toBe("2026-06-30T22:00:00.000Z"); // летом UTC+2
  });

  it("границы месяца переходят через год", () => {
    const p = periodBounds(new Date("2026-12-15T00:00:00Z"), "Asia/Almaty");
    expect(p.monthEnd.toISOString()).toBe("2026-12-31T19:00:00.000Z");
  });

  it("некорректный или пустой пояс заменяется на Asia/Almaty", () => {
    expect(resolveTimezone(undefined)).toBe("Asia/Almaty");
    expect(resolveTimezone("  ")).toBe("Asia/Almaty");
    expect(resolveTimezone("Нет/Такого")).toBe("Asia/Almaty");
    expect(resolveTimezone("Europe/Berlin")).toBe("Europe/Berlin");
  });
});

describe("выбор подписки и уровня", () => {
  it("действует только active|grace с неистёкшим сроком", () => {
    expect(isSubscriptionActive(sub("pro"), NOW)).toBe(true);
    expect(isSubscriptionActive(sub("pro", { status: "grace" }), NOW)).toBe(true);
    expect(isSubscriptionActive(sub("pro", { status: "expired" }), NOW)).toBe(false);
    expect(isSubscriptionActive(sub("pro", { status: "revoked" }), NOW)).toBe(false);
    expect(isSubscriptionActive(sub("pro", { expiresAt: new Date("2026-09-01T00:00:00Z") }), NOW)).toBe(false);
    // Бессрочная ручная подписка без срока
    expect(isSubscriptionActive(sub("pro", { expiresAt: null }), NOW)).toBe(true);
  });

  it("из нескольких активных берётся самый высокий уровень", () => {
    expect(pickSubscription([sub("starter"), sub("unlimited"), sub("pro")], NOW)!.tier).toBe("unlimited");
    // Истёкший «безлимит» не перебивает действующий starter
    expect(pickSubscription([sub("starter"), sub("unlimited", { status: "expired" })], NOW)!.tier).toBe("starter");
    expect(pickSubscription([sub("pro", { status: "revoked" })], NOW)).toBeNull();
    expect(pickSubscription([], NOW)).toBeNull();
  });

  it("без подписки — free, с подпиской — её уровень", () => {
    expect(resolveTier(null, null, NOW)).toEqual({ tier: "free", source: "free" });
    expect(resolveTier(sub("starter"), org(), NOW)).toEqual({ tier: "starter", source: "subscription" });
    expect(resolveTier(sub("pro", { status: "expired" }), null, NOW)).toEqual({ tier: "free", source: "free" });
  });

  it("enterprise организации важнее личной подписки, истёкший план — нет", () => {
    const active = org({ plan: "enterprise", planSeats: 10, planUntil: new Date("2026-12-31T00:00:00Z") });
    const expired = org({ plan: "enterprise", planSeats: 10, planUntil: new Date("2026-01-01T00:00:00Z") });
    expect(isEnterpriseActive(active, NOW)).toBe(true);
    expect(isEnterpriseActive(expired, NOW)).toBe(false);
    expect(isEnterpriseActive(org({ plan: "enterprise", planUntil: null }), NOW)).toBe(true);
    expect(resolveTier(sub("pro"), active, NOW)).toEqual({ tier: "enterprise", source: "enterprise" });
    expect(resolveTier(sub("pro"), expired, NOW)).toEqual({ tier: "pro", source: "subscription" });
    expect(resolveTier(null, expired, NOW)).toEqual({ tier: "free", source: "free" });
  });
});

describe("лимиты тарифов", () => {
  it("free: 5 минут, 5 записей в день, без онлайн-встреч, черновая модель", () => {
    expect(TIER_LIMITS.free).toEqual({ maxRecordingSec: 300, monthlyLimitSec: null, dailyRecordings: 5, onlineMeetings: false, model: "draft" });
  });

  it("платные уровни по таблице тарифов", () => {
    expect(limitsFor("starter")).toMatchObject({ maxRecordingSec: 3600, monthlyLimitSec: 18000, dailyRecordings: null, onlineMeetings: false, model: "draft" });
    expect(limitsFor("pro")).toMatchObject({ maxRecordingSec: 10800, monthlyLimitSec: 54000, dailyRecordings: null, onlineMeetings: true, model: "full" });
    expect(limitsFor("unlimited")).toMatchObject({ maxRecordingSec: 18000, monthlyLimitSec: 144000, onlineMeetings: true, model: "full" });
  });

  it("enterprise: пул 20 часов на место организации", () => {
    expect(limitsFor("enterprise", 1).monthlyLimitSec).toBe(72000);
    expect(limitsFor("enterprise", 100).monthlyLimitSec).toBe(7_200_000);
    // Без указанных мест считаем одно, а не безлимит
    expect(limitsFor("enterprise", null).monthlyLimitSec).toBe(72000);
    expect(limitsFor("enterprise", 5)).toMatchObject({ maxRecordingSec: 18000, onlineMeetings: true, model: "full" });
  });

  it("длительность записи: допуск 10 % сверх лимита", () => {
    const free = TIER_LIMITS.free;
    expect(isOverDuration(300, free)).toBe(false);
    expect(isOverDuration(330, free)).toBe(false); // ровно +10 %
    expect(isOverDuration(331, free)).toBe(true);
    expect(isOverDuration(null, free)).toBe(false);
    expect(isOverDuration(0, free)).toBe(false);
  });

  it("уровень по product id", () => {
    expect(tierForProduct("lakonik.pro.yearly")).toBe("pro");
    expect(tierForProduct("lakonik.unlimited.monthly")).toBe("unlimited");
    expect(tierForProduct("manual.starter")).toBe("starter");
    expect(tierForProduct("com.other.app.pro")).toBeNull();
    expect(tierForProduct(undefined)).toBeNull();
    expect(periodForProduct("lakonik.pro.yearly")).toBe("yearly");
    expect(periodForProduct("manual.pro")).toBe("manual");
  });
});

describe("уведомления App Store → статус подписки", () => {
  it("покупка и продление включают подписку", () => {
    expect(effectOfNotification("SUBSCRIBED", "INITIAL_BUY")).toEqual({ status: "active", autoRenew: true });
    expect(effectOfNotification("DID_RENEW")).toEqual({ status: "active", autoRenew: true });
  });

  it("отключение автопродления не отбирает доступ", () => {
    expect(effectOfNotification("DID_CHANGE_RENEWAL_STATUS", "AUTO_RENEW_DISABLED")).toEqual({ autoRenew: false });
    expect(effectOfNotification("DID_CHANGE_RENEWAL_STATUS", "AUTO_RENEW_ENABLED")).toEqual({ autoRenew: true });
  });

  it("льготный период, истечение, возврат и отзыв", () => {
    expect(effectOfNotification("DID_FAIL_TO_RENEW", "GRACE_PERIOD")).toEqual({ status: "grace" });
    expect(effectOfNotification("DID_FAIL_TO_RENEW")).toEqual({ status: "expired" });
    expect(effectOfNotification("EXPIRED", "VOLUNTARY")).toEqual({ status: "expired" });
    expect(effectOfNotification("GRACE_PERIOD_EXPIRED")).toEqual({ status: "expired" });
    expect(effectOfNotification("REFUND")).toEqual({ status: "revoked" });
    expect(effectOfNotification("REVOKE")).toEqual({ status: "revoked" });
  });

  it("прочие типы только обновляют данные транзакции", () => {
    expect(effectOfNotification("PRICE_INCREASE")).toEqual({});
    expect(effectOfNotification("TEST")).toEqual({});
    expect(effectOfNotification(undefined)).toEqual({});
  });

  it("статус из App Store Server API", () => {
    expect(statusFromApple(1)).toBe("active");
    expect(statusFromApple(2)).toBe("expired");
    expect(statusFromApple(3)).toBe("expired"); // повторные попытки списания — доступа нет
    expect(statusFromApple(4)).toBe("grace");
    expect(statusFromApple(5)).toBe("revoked");
    expect(statusFromApple(undefined)).toBe("expired");
  });
});
