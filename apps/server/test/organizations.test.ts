import { describe, expect, it } from "vitest";
import { emailDomainOf, isPublicDomain, newInviteToken } from "../src/db/organizations.js";

describe("домены организаций", () => {
  it("публичные домены не подтверждаются", () => {
    for (const d of ["gmail.com", "mail.ru", "yandex.kz", "icloud.com", "privaterelay.appleid.com", "x.appleid.com"]) expect(isPublicDomain(d)).toBe(true);
    for (const d of ["advgroup.kz", "orbita.kz", "havas.kz"]) expect(isPublicDomain(d)).toBe(false);
  });
  it("домен почты нормализуется", () => {
    expect(emailDomainOf("Asel@ADVGroup.KZ")).toBe("advgroup.kz");
    expect(emailDomainOf("broken")).toBe("");
  });
  it("токен приглашения — url-safe и уникален", () => {
    const a = newInviteToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect(a).not.toBe(newInviteToken());
  });
});
