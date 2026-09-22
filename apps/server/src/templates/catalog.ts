import templatesJson from "@lakonik/shared/templates.json" with { type: "json" };
import legacyTemplatesJson from "@lakonik/shared/templates-adv.json" with { type: "json" };
import type { TemplateField, TemplateSection } from "../db/types.js";

/**
 * Коды групп обеих версий каталога: встроенный (client | internal | partner | people | notes)
 * и приватный каталог организации переноса (client | internal | vendor).
 */
export type CatalogGroupCode = "client" | "internal" | "partner" | "people" | "notes" | "vendor";

export interface CatalogGroup {
  code: CatalogGroupCode;
  title: string;
  subtitle: string;
  emoji: string;
  color: string;
  order: number;
}

export interface CatalogTemplate {
  code: string;
  group: CatalogGroupCode;
  category: string;
  sheet: string | null;
  title: string;
  subtitle: string;
  goal: string;
  reportTitle: string;
  emojiOverride?: string;
  confidentiality: "standard" | "restricted";
  allowConfidentialityChoice: boolean;
  slaHours: number;
  sendTo: string;
  tone: string;
  specificFields: TemplateField[];
  reportSections: TemplateSection[];
  rules: string[];
  tips: string[];
  isDraft: boolean;
}

export interface Catalog {
  version: number;
  groups: CatalogGroup[];
  categories: { code: string; title: string; order: number }[];
  commonFields: TemplateField[];
  globalRules: string[];
  templates: CatalogTemplate[];
}

/** Встроенный каталог: сидится с organization_id = null и доступен всем организациям */
export const catalog = templatesJson as unknown as Catalog;

/** Приватный каталог организации переноса (ADV): сидится только ей, через seedLegacyTemplates */
export const legacyCatalog = legacyTemplatesJson as unknown as Catalog;

export function groupOf(code: string, from: Catalog = catalog): CatalogGroup {
  const g = from.groups.find((x) => x.code === code);
  if (!g) throw new Error(`Неизвестная группа шаблонов: ${code}`);
  return g;
}

/** Группа по коду в любом из каталогов: сначала встроенный, затем приватный (для ответа /templates) */
export function findGroup(code: string): CatalogGroup | undefined {
  return catalog.groups.find((x) => x.code === code) ?? legacyCatalog.groups.find((x) => x.code === code);
}
