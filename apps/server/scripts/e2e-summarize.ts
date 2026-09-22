/**
 * Проверка только LLM-шага: берёт тестовый транскрипт (FakeStt) и прогоняет реальное саммари Claude
 * по указанному шаблону. Печатает JSON-структуру, markdown, токены и стоимость.
 *   pnpm --filter @lakonik/server exec tsx --env-file=.env scripts/e2e-summarize.ts [код шаблона] [effort]
 */
import { and, eq } from "drizzle-orm";
import { closeDb, db } from "../src/db/client.js";
import { meetingTemplates, meetings, transcripts } from "../src/db/schema/index.js";
import { FakeStt } from "../src/stt/fake.js";
import { summarizeTranscript, type Effort } from "../src/llm/summarize.js";
import { renderMarkdown } from "../src/export/markdown.js";

const [templateCode = "client_brief", effort = "high"] = process.argv.slice(2);
const d = db();
const [tpl] = await d.select().from(meetingTemplates).where(and(eq(meetingTemplates.code, templateCode), eq(meetingTemplates.isActive, true))).limit(1);
if (!tpl) throw new Error(`Шаблон ${templateCode} не найден`);

const stt = await new FakeStt().transcribe({ sourceUrl: "fake" });
const now = new Date();
const meeting = {
  id: "00000000-0000-0000-0000-000000000000",
  ownerId: "e2e",
  agencyId: null,
  organizationId: null,
  templateId: tpl.id,
  templateCode: tpl.code,
  templateVersion: tpl.version,
  title: "Тест: бриф Nomad Summer",
  status: "summarizing",
  statusDetail: null,
  error: null,
  source: "imported",
  confidentiality: "standard",
  startedAt: now,
  endedAt: now,
  durationSec: 36,
  contextFields: { campaign: "Nomad Summer", product: "Qazaq Beverages, лимонад Nomad" },
  participantsHint: [{ name: "Айгерим", role: "аккаунт-директор", company: "ADV", side: "ours" as const }],
  numSpeakersHint: 3,
  languageHint: "ru",
  platform: "Zoom",
  markers: [],
  segmentCount: 1,
  deviceId: null,
  createdAt: now,
  updatedAt: now,
} satisfies typeof meetings.$inferSelect;

const transcript = {
  id: "t",
  meetingId: meeting.id,
  provider: stt.provider,
  providerRequestId: null,
  languageCode: stt.languageCode,
  languageProbability: "0.99",
  fullText: stt.fullText,
  segments: stt.segments,
  speakers: { speaker_0: "Айгерим" },
  selfSpeakerId: "speaker_0",
  speakerRoles: { speaker_0: "ours" as const, speaker_1: "client" as const },
  speakerSuggestions: null,
  speakersConfirmedAt: null,
  audioDurationSec: "36",
  wordCount: stt.wordCount,
  costUsd: "0",
  createdAt: now,
  updatedAt: now,
} satisfies typeof transcripts.$inferSelect;

const t0 = Date.now();
const res = await summarizeTranscript(tpl, meeting, transcript, { effort: effort as Effort });
const ms = Date.now() - t0;
console.log(`■ модель ${res.servedBy}, effort ${res.effort}, ${ms} мс, tokens in ${res.usage.input} / out ${res.usage.output} / cacheRead ${res.usage.cacheRead} / cacheWrite ${res.usage.cacheWrite}, cost $${res.costUsd}`);
console.log("■ JSON:", JSON.stringify(res.output, null, 1).slice(0, 2500));
const o = res.output;
const row = {
  ...transcript,
  id: "r",
  version: 1,
  templateId: tpl.id,
  templateCode: tpl.code,
  templateVersion: tpl.version,
  model: res.model,
  effort: res.effort,
  title: o.title,
  summary: o.summary,
  participants: o.participants,
  sections: o.sections.map((s) => ({ key: s.key, heading: tpl.reportSections.find((x) => x.key === s.key)?.heading ?? s.key, content: s.content, internalOnly: tpl.reportSections.find((x) => x.key === s.key)?.internalOnly ?? false })),
  actionItems: o.actionItems.map((a) => ({ ...a, done: false })),
  decisions: o.decisions,
  openQuestions: o.openQuestions,
  clientRequests: o.clientRequests,
  missingInfo: o.missingInfo,
  nextMeeting: o.nextMeeting,
  markdown: "",
  inputTokens: res.usage.input,
  outputTokens: res.usage.output,
  cacheReadTokens: res.usage.cacheRead,
  createdBy: "pipeline",
  isCurrent: true,
  editedAt: null,
  editedBy: null,
  instructions: null,
};
console.log("\n" + renderMarkdown(tpl, row as never, { startedAt: now, durationSec: 36, platform: "Zoom", templateTitle: tpl.title, confidentiality: "standard", includeInternal: true }));
await closeDb();
