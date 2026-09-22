import { config } from "../config.js";
import { DEFAULT_TIMEZONE } from "../billing/entitlement.js";
import type { Participant } from "../db/types.js";
import { downloadToFile, fetchJson, IntegrationError, postForm } from "./http.js";

/**
 * Google Meet: OAuth и Meet REST API v2 (conferenceRecords, recordings, participants, transcripts)
 * плюс скачивание файла записи из Drive. Чистые разборщики ответов вынесены отдельно — они под тестами.
 */

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";
const MEET_API = "https://meet.googleapis.com/v2";
const DRIVE_API = "https://www.googleapis.com/drive/v3";

export const GOOGLE_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/meetings.space.readonly",
  "https://www.googleapis.com/auth/drive.meet.readonly",
];

export const googleRedirectUri = (): string => `${config().BASE_URL}/api/integrations/google_meet/callback`;

/** Настроен ли OAuth-клиент Google на этом сервере */
export const googleConfigured = (): boolean => !!config().GOOGLE_INTEGRATION_CLIENT_ID && !!config().GOOGLE_INTEGRATION_CLIENT_SECRET;

export function googleAuthUrl(state: string): string {
  const cfg = config();
  const q = new URLSearchParams({
    client_id: cfg.GOOGLE_INTEGRATION_CLIENT_ID ?? "",
    redirect_uri: googleRedirectUri(),
    response_type: "code",
    scope: GOOGLE_SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state,
  });
  return `${AUTH_URL}?${q.toString()}`;
}

export interface GoogleTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
  scopes: string[];
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
}

function tokensOf(r: TokenResponse): GoogleTokens {
  if (!r.access_token) throw new IntegrationError("Google Meet: провайдер не вернул токен доступа", { retryable: false });
  return {
    accessToken: r.access_token,
    refreshToken: r.refresh_token ?? null,
    expiresAt: r.expires_in ? new Date(Date.now() + r.expires_in * 1000) : null,
    scopes: r.scope ? r.scope.split(" ").filter(Boolean) : [],
  };
}

export async function exchangeGoogleCode(code: string): Promise<GoogleTokens> {
  const cfg = config();
  const r = await postForm<TokenResponse>(
    TOKEN_URL,
    {
      code,
      client_id: cfg.GOOGLE_INTEGRATION_CLIENT_ID ?? "",
      client_secret: cfg.GOOGLE_INTEGRATION_CLIENT_SECRET ?? "",
      redirect_uri: googleRedirectUri(),
      grant_type: "authorization_code",
    },
    { what: "Google Meet: обмен кода на токены" },
  );
  return tokensOf(r);
}

export async function refreshGoogleToken(refreshToken: string): Promise<GoogleTokens> {
  const cfg = config();
  const r = await postForm<TokenResponse>(
    TOKEN_URL,
    { refresh_token: refreshToken, client_id: cfg.GOOGLE_INTEGRATION_CLIENT_ID ?? "", client_secret: cfg.GOOGLE_INTEGRATION_CLIENT_SECRET ?? "", grant_type: "refresh_token" },
    { what: "Google Meet: обновление токена" },
  );
  return tokensOf(r);
}

export async function googleAccount(accessToken: string): Promise<{ email: string | null; sub: string | null }> {
  const r = await fetchJson<{ email?: string; sub?: string }>(USERINFO_URL, { what: "Google Meet: данные аккаунта", headers: { Authorization: `Bearer ${accessToken}` } });
  return { email: r.email ?? null, sub: r.sub ?? null };
}

/** Отзыв доступа — best effort, ошибки гасит вызывающий код */
export async function revokeGoogleToken(token: string): Promise<void> {
  await postForm<unknown>(REVOKE_URL, { token }, { what: "Google Meet: отзыв доступа", timeoutMs: 10_000 });
}

// ---------- Meet REST API v2 ----------

export interface ConferenceRecord {
  name: string; // conferenceRecords/<id>
  startTime: string | null;
  endTime: string | null;
  space: string | null; // spaces/<id>
}

export interface MeetRecording {
  name: string; // conferenceRecords/<id>/recordings/<id>
  fileId: string;
  state: string;
  startTime: string | null;
  endTime: string | null;
}

export interface MeetParticipant {
  name: string; // conferenceRecords/<id>/participants/<id>
  displayName: string | null;
}

export interface MeetTranscriptEntry {
  participant: string | null;
  text: string;
  startTime: string | null;
}

type Json = Record<string, unknown>;
const arr = (v: unknown): Json[] => (Array.isArray(v) ? (v as Json[]) : []);
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

export function parseConferenceRecords(json: unknown): ConferenceRecord[] {
  return arr((json as Json)?.conferenceRecords)
    .map((r) => ({ name: str(r.name) ?? "", startTime: str(r.startTime), endTime: str(r.endTime), space: str(r.space) }))
    .filter((r) => !!r.name);
}

/** Только готовые файлы записи, лежащие в Drive */
export function parseRecordings(json: unknown): MeetRecording[] {
  return arr((json as Json)?.recordings)
    .map((r) => {
      const dst = (r.driveDestination ?? {}) as Json;
      return { name: str(r.name) ?? "", fileId: str(dst.file) ?? "", state: str(r.state) ?? "", startTime: str(r.startTime), endTime: str(r.endTime) };
    })
    .filter((r) => !!r.name && !!r.fileId && r.state === "FILE_GENERATED");
}

export function parseParticipants(json: unknown): MeetParticipant[] {
  return arr((json as Json)?.participants)
    .map((p) => {
      const signedin = (p.signedinUser ?? {}) as Json;
      const anon = (p.anonymousUser ?? {}) as Json;
      const phone = (p.phoneUser ?? {}) as Json;
      return { name: str(p.name) ?? "", displayName: str(signedin.displayName) ?? str(anon.displayName) ?? str(phone.displayName) };
    })
    .filter((p) => !!p.name);
}

export function parseTranscriptEntries(json: unknown): MeetTranscriptEntry[] {
  return arr((json as Json)?.transcriptEntries)
    .map((e) => ({ participant: str(e.participant), text: str(e.text) ?? "", startTime: str(e.startTime) }))
    .filter((e) => !!e.text);
}

/** Имена участников для participantsHint встречи (без дублей, не больше 20) */
export function participantsHint(list: MeetParticipant[]): Participant[] {
  const seen = new Set<string>();
  const out: Participant[] = [];
  for (const p of list) {
    const name = p.displayName?.trim();
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.push({ name, role: null, company: null, side: "unknown" });
    if (out.length >= 20) break;
  }
  return out;
}

const mmss = (sec: number): string => `${String(Math.floor(sec / 60)).padStart(2, "0")}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;

/**
 * Транскрипт Meet компактным текстом: «[мм:сс] Имя: реплика». Идёт подсказкой шагу анализа спикеров —
 * расшифровка остаётся нашей (Scribe лучше в казахском и диаризации).
 */
export function formatMeetTranscript(entries: MeetTranscriptEntry[], participants: MeetParticipant[], maxChars = 20_000): string {
  const names = new Map(participants.map((p) => [p.name, p.displayName ?? "Участник"]));
  const base = entries.find((e) => e.startTime)?.startTime;
  const zero = base ? new Date(base).getTime() : null;
  const lines = entries.map((e) => {
    const at = zero && e.startTime ? mmss(Math.max(0, (new Date(e.startTime).getTime() - zero) / 1000)) : null;
    const who = (e.participant && names.get(e.participant)) || "Участник";
    return `${at ? `[${at}] ` : ""}${who}: ${e.text.trim()}`;
  });
  const text = lines.join("\n");
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n… (обрезано)` : text;
}

export const googleExternalRef = (recordingName: string): string => `google_meet:${recordingName}`;

/** Название импортированной встречи: код встречи Meet и дата начала */
export function meetTitle(startTime: string | null, meetingCode: string | null): string {
  const when = startTime ? new Date(startTime).toLocaleString("ru-RU", { timeZone: DEFAULT_TIMEZONE, dateStyle: "short", timeStyle: "short" }) : null;
  return ["Google Meet", meetingCode, when].filter(Boolean).join(" · ");
}

const auth = (accessToken: string) => ({ Authorization: `Bearer ${accessToken}` });

/** Конференции, начавшиеся не раньше `since` (фильтр Meet API — строка RFC 3339 в кавычках) */
export async function listConferenceRecords(accessToken: string, since: Date, pageSize = 50): Promise<ConferenceRecord[]> {
  const q = new URLSearchParams({ filter: `start_time>="${since.toISOString()}"`, pageSize: String(pageSize) });
  const json = await fetchJson<unknown>(`${MEET_API}/conferenceRecords?${q.toString()}`, { what: "Google Meet: список конференций", headers: auth(accessToken) });
  return parseConferenceRecords(json);
}

export async function listRecordings(accessToken: string, conferenceName: string): Promise<MeetRecording[]> {
  const json = await fetchJson<unknown>(`${MEET_API}/${conferenceName}/recordings`, { what: "Google Meet: записи конференции", headers: auth(accessToken) });
  return parseRecordings(json);
}

export async function listParticipants(accessToken: string, conferenceName: string): Promise<MeetParticipant[]> {
  const json = await fetchJson<unknown>(`${MEET_API}/${conferenceName}/participants?pageSize=100`, { what: "Google Meet: участники конференции", headers: auth(accessToken) });
  return parseParticipants(json);
}

/** Транскрипт Meet, если хост его включал: берём первый и не больше `maxPages` страниц реплик */
export async function loadTranscript(accessToken: string, conferenceName: string, maxPages = 5): Promise<MeetTranscriptEntry[]> {
  const list = await fetchJson<{ transcripts?: { name?: string }[] }>(`${MEET_API}/${conferenceName}/transcripts`, { what: "Google Meet: транскрипты конференции", headers: auth(accessToken) });
  const first = list.transcripts?.find((t) => t.name)?.name;
  if (!first) return [];
  const entries: MeetTranscriptEntry[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const q = new URLSearchParams({ pageSize: "1000", ...(pageToken ? { pageToken } : {}) });
    const json = await fetchJson<{ nextPageToken?: string }>(`${MEET_API}/${first}/entries?${q.toString()}`, { what: "Google Meet: реплики транскрипта", headers: auth(accessToken) });
    entries.push(...parseTranscriptEntries(json));
    pageToken = json.nextPageToken;
    if (!pageToken) break;
  }
  return entries;
}

/** Код встречи (abc-defg-hij) — best effort: при ошибке названию хватит даты */
export async function meetingCodeOf(accessToken: string, spaceName: string | null): Promise<string | null> {
  if (!spaceName) return null;
  const json = await fetchJson<{ meetingCode?: string }>(`${MEET_API}/${spaceName}`, { what: "Google Meet: пространство встречи", headers: auth(accessToken) });
  return json.meetingCode ?? null;
}

/** Файл записи из Drive (mp4) потоком во временный файл */
export async function downloadDriveFile(accessToken: string, fileId: string, dest: string): Promise<number> {
  return downloadToFile(`${DRIVE_API}/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`, dest, {
    what: "Google Meet: скачивание записи из Drive",
    headers: auth(accessToken),
  });
}
