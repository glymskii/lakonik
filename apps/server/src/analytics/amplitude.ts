import { config } from "../config.js";
import { logger } from "../logger.js";

/**
 * Продуктовая аналитика: события с сервера в Amplitude (HTTP API v2). Без AMPLITUDE_API_KEY — только в лог на уровне debug.
 * user_id = id пользователя (не email); в свойствах — никакого содержимого встреч.
 */
export type AnalyticsEvent =
  | "signup" | "login" | "recording_started" | "recording_finished" | "file_imported" | "transcript_ready" | "report_ready"
  | "report_regenerated" | "speakers_confirmed" | "meeting_shared" | "task_done" | "meeting_deleted" | "account_deleted"
  | "organization_created" | "invite_accepted" | "workspace_selected";

type Props = Record<string, string | number | boolean | null | undefined>;

const queue: Array<{ user_id: string; event_type: string; event_properties: Props; time: number; insert_id: string }> = [];
let timer: NodeJS.Timeout | null = null;

export function track(userId: string, event: AnalyticsEvent, props: Props = {}) {
  const cfg = config();
  const item = { user_id: userId, event_type: event, event_properties: props, time: Date.now(), insert_id: `${userId}:${event}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}` };
  if (!cfg.AMPLITUDE_API_KEY) {
    logger.debug({ event, userId, props }, "analytics (без ключа)");
    return;
  }
  queue.push(item);
  if (queue.length >= 20) void flush();
  else if (!timer) timer = setTimeout(() => void flush(), 3000);
}

export async function flush() {
  if (timer) { clearTimeout(timer); timer = null; }
  if (!queue.length) return;
  const cfg = config();
  const events = queue.splice(0, queue.length);
  try {
    const res = await fetch("https://api2.amplitude.com/2/httpapi", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "*/*" },
      body: JSON.stringify({ api_key: cfg.AMPLITUDE_API_KEY, events }),
    });
    if (!res.ok) logger.warn({ status: res.status, body: (await res.text()).slice(0, 200) }, "Amplitude: ошибка отправки");
  } catch (e) {
    logger.warn({ err: (e as Error).message }, "Amplitude: недоступен");
  }
}
