import templatesJson from "@lakonik/shared/templates.json" with { type: "json" };
import type { TemplateField, TemplateSection } from "../db/types.js";

export interface CatalogGroup {
  code: "internal" | "client" | "vendor";
  title: string;
  subtitle: string;
  emoji: string;
  color: string;
  order: number;
}

export interface CatalogTemplate {
  code: string;
  group: "internal" | "client" | "vendor";
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

export const catalog = templatesJson as unknown as Catalog;

export function groupOf(code: string): CatalogGroup {
  const g = catalog.groups.find((x) => x.code === code);
  if (!g) throw new Error(`Неизвестная группа шаблонов: ${code}`);
  return g;
}
