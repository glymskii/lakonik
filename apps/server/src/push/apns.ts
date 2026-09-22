import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { eq, inArray } from "drizzle-orm";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { db } from "../db/client.js";
import { devices, meetings, reports, tasks } from "../db/schema/index.js";
import { formatRuDate, getDeadlineSettings, tasksDueForReminder } from "../tasks/service.js";
import type { NotifyJob } from "../queue/boss.js";

/**
 * Минимальный APNs-клиент (HTTP/2, token-based auth, .p8).
 * Node 22 умеет HTTP/2 из коробки — сторонняя библиотека не нужна.
 */
let cachedJwt: { token: string; issuedAt: number } | null = null;

let cachedKey: string | null | undefined;
function apnsPrivateKey(): string | null {
  if (cachedKey !== undefined) return cachedKey;
  const cfg = config();
  if (cfg.APNS_PRIVATE_KEY_FILE) {
    try {
      cachedKey = readFileSync(cfg.APNS_PRIVATE_KEY_FILE, "utf8");
    } catch (e) {
      logger.error({ file: cfg.APNS_PRIVATE_KEY_FILE, err: (e as Error).message }, "APNS_PRIVATE_KEY_FILE не читается");
      cachedKey = null;
    }
  } else {
    cachedKey = cfg.APNS_PRIVATE_KEY ? cfg.APNS_PRIVATE_KEY.replace(/\\n/g, "\n") : null;
  }
  return cachedKey;
}

function apnsJwt(): string | null {
  const cfg = config();
  const key = apnsPrivateKey();
  if (!cfg.APNS_KEY_ID || !cfg.APNS_TEAM_ID || !key) return null;
  const now = Math.floor(Date.now() / 1000);
  if (cachedJwt && now - cachedJwt.issuedAt < 50 * 60) return cachedJwt.token;
  const header = Buffer.from(JSON.stringify({ alg: "ES256", kid: cfg.APNS_KEY_ID })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ iss: cfg.APNS_TEAM_ID, iat: now })).toString("base64url");
  const signer = createSign("SHA256");
  signer.update(`${header}.${payload}`);
  const signature = signer.sign({ key, dsaEncoding: "ieee-p1363" }).toString("base64url");
  cachedJwt = { token: `${header}.${payload}.${signature}`, issuedAt: now };
  return cachedJwt.token;
}

export interface PushPayload {
  title: string;
  body: string;
  data?: Record<string, string>;
  threadId?: string;
}

/** Токены, для которых уже известно рабочее окружение APNs (dev-сборки из Xcode → sandbox, TestFlight/App Store → production). */
const tokenEnv = new Map<string, "production" | "sandbox">();

/**
 * Отправка push. Пробует основное окружение (APNS_PRODUCTION), при BadDeviceToken — другое:
 * так одновременно работают dev-сборки (sandbox) и TestFlight (production).
 */
export async function sendApns(deviceToken: string, payload: PushPayload): Promise<"ok" | "invalid_token" | "error" | "disabled"> {
  const cfg = config();
  const primary: "production" | "sandbox" = tokenEnv.get(deviceToken) ?? (cfg.APNS_PRODUCTION ? "production" : "sandbox");
  const first = await sendApnsTo(primary, deviceToken, payload);
  if (first !== "invalid_token") {
    if (first === "ok") tokenEnv.set(deviceToken, primary);
    return first;
  }
  const other = primary === "production" ? "sandbox" : "production";
  const second = await sendApnsTo(other, deviceToken, payload);
  if (second === "ok") tokenEnv.set(deviceToken, other);
  return second;
}

async function sendApnsTo(env: "production" | "sandbox", deviceToken: string, payload: PushPayload): Promise<"ok" | "invalid_token" | "error" | "disabled"> {
  const jwt = apnsJwt();
  if (!jwt) return "disabled";
  const cfg = config();
  const http2 = await import("node:http2");
  const host = env === "production" ? "https://api.push.apple.com" : "https://api.sandbox.push.apple.com";
  const client = http2.connect(host);
  try {
    return await new Promise((resolve) => {
      const req = client.request({
        ":method": "POST",
        ":path": `/3/device/${deviceToken}`,
        authorization: `bearer ${jwt}`,
        "apns-topic": cfg.APNS_BUNDLE_ID,
        "apns-push-type": "alert",
        "apns-priority": "10",
        "content-type": "application/json",
      });
      let status = 0;
      let body = "";
      req.on("response", (h) => (status = Number(h[":status"])));
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        if (status === 200) resolve("ok");
        else if (status === 410 || (status === 400 && /BadDeviceToken|DeviceTokenNotForTopic/.test(body))) resolve("invalid_token");
        else {
          logger.warn({ status, body, env }, "APNs error");
          resolve("error");
        }
      });
      req.on("error", (e) => {
        logger.warn(e, "APNs request error");
        resolve("error");
      });
      req.end(
        JSON.stringify({
          aps: { alert: { title: payload.title, body: payload.body }, sound: "default", "thread-id": payload.threadId },
          ...payload.data,
        }),
      );
    });
  } finally {
    client.close();
  }
}

/** Отправка одного уведомления на все устройства пользователя (битые токены удаляются). */
async function sendToUser(userId: string, payload: PushPayload, ctx: Record<string, unknown> = {}): Promise<void> {
  const d = db();
  const userDevices = await d.select().from(devices).where(eq(devices.userId, userId));
  for (const dev of userDevices) {
    if (dev.platform !== "ios") continue;
    const res = await sendApns(dev.pushToken, payload);
    if (res === "invalid_token") await d.delete(devices).where(eq(devices.id, dev.id));
    if (res === "disabled") {
      logger.info({ ...ctx }, "APNs не настроен — push пропущен");
      return;
    }
    logger.info({ ...ctx, result: res, env: tokenEnv.get(dev.pushToken) ?? null, token: dev.pushToken.slice(0, 8) }, "Push отправлен");
  }
}

/** Уведомление владельца встречи о готовности отчёта / ошибке, а также о пропущенном импорте из Meet/Zoom. */
export async function notifyMeeting(job: NotifyJob): Promise<void> {
  const d = db();
  if (job.kind === "import_skipped") {
    await sendToUser(job.userId, { title: "Запись не импортирована", body: job.text, data: { kind: "import_skipped" }, threadId: "integrations" }, { kind: job.kind });
    return;
  }
  const [m] = await d.select().from(meetings).where(eq(meetings.id, job.meetingId)).limit(1);
  if (!m) return;

  let payload: PushPayload;
  if (job.kind === "report_ready") {
    const [r] = await d.select({ title: reports.title }).from(reports).where(eq(reports.meetingId, m.id)).limit(1);
    payload = { title: "Отчёт готов", body: r?.title ?? m.title, data: { meetingId: m.id, kind: "report_ready" }, threadId: m.id };
  } else if (job.kind === "transcript_ready") {
    payload = { title: "Расшифровка готова", body: `${m.title} — проверьте спикеров и выберите тип встречи, чтобы получить отчёт`, data: { meetingId: m.id, kind: "transcript_ready" }, threadId: m.id };
  } else {
    payload = { title: "Не удалось обработать запись", body: m.error ?? m.title, data: { meetingId: m.id, kind: "failed" }, threadId: m.id };
  }

  await sendToUser(m.ownerId, payload, { meetingId: m.id, kind: job.kind });
}


/** Ежедневные напоминания о дедлайнах задач владельцам встреч (одно уведомление на пользователя). */
export async function sendTaskReminders(): Promise<number> {
  const d = db();
  const s = await getDeadlineSettings();
  // Отправляем только в назначенный час по Алматы (cron дергает каждый час)
  const hourAlmaty = (new Date().getUTCHours() + 5) % 24;
  if (hourAlmaty !== s.remindHourLocal) return 0;
  const due = (await tasksDueForReminder()).filter((t) => !t.remindedAt);
  if (due.length === 0) return 0;
  const byOwner = new Map<string, typeof due>();
  for (const t of due) byOwner.set(t.ownerId, [...(byOwner.get(t.ownerId) ?? []), t]);
  let sent = 0;
  for (const [ownerId, list] of byOwner) {
    const userDevices = await d.select().from(devices).where(eq(devices.userId, ownerId));
    const first = list[0]!;
    const body = list.length === 1
      ? `${first.task}${first.assigneeName ? " — " + first.assigneeName : ""} · срок ${formatRuDate(first.deadlineDate!)}`
      : `${list.length} задач со сроком ${formatRuDate(first.deadlineDate!)}: ${list.slice(0, 2).map((t) => t.task).join("; ")}…`;
    for (const dev of userDevices) {
      if (dev.platform !== "ios") continue;
      const res = await sendApns(dev.pushToken, { title: s.remindDaysBefore === 0 ? "Дедлайн сегодня" : "Завтра дедлайн", body, data: { kind: "task_reminder", meetingId: first.meetingId }, threadId: "tasks" });
      if (res === "invalid_token") await d.delete(devices).where(eq(devices.id, dev.id));
      if (res === "ok") sent++;
    }
    await d.update(tasks).set({ remindedAt: new Date() }).where(inArray(tasks.id, list.map((t) => t.id)));
  }
  logger.info({ users: byOwner.size, tasks: due.length, sent }, "Напоминания о дедлайнах");
  return sent;
}
