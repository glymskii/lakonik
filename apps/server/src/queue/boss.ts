import { PgBoss } from "pg-boss";
import { config } from "../config.js";
import { logger } from "../logger.js";

export const QUEUES = {
  processMeeting: "meeting.process",
  processMeetingDlq: "meeting.process.dlq",
  audioSweep: "audio.sweep",
  stuckSweep: "meetings.stuck",
  notify: "meeting.notify",
  taskReminders: "tasks.remind",
  subscriptionsSync: "billing.sync",
} as const;

export interface ProcessMeetingJob {
  meetingId: string;
  /** Пересобрать отчёт (транскрипт уже есть) */
  regenerate?: boolean;
  /** Опции регенерации */
  templateId?: string;
  effort?: "low" | "medium" | "high" | "xhigh";
  model?: string;
  /** Текстовые правки пользователя для ИИ-пересборки */
  instructions?: string;
}

export interface NotifyJob {
  meetingId: string;
  kind: "report_ready" | "transcript_ready" | "failed";
}

let boss: PgBoss | null = null;

export async function getBoss(): Promise<PgBoss> {
  if (boss) return boss;
  const b = new PgBoss({ connectionString: config().DATABASE_URL, schema: "pgboss", max: 4 });
  b.on("error", (e) => logger.error(e, "pg-boss error"));
  await b.start();
  await b.createQueue(QUEUES.processMeetingDlq, { retryLimit: 0, retentionSeconds: 60 * 60 * 24 * 14 });
  await b.createQueue(QUEUES.processMeeting, {
    retryLimit: 3,
    retryDelay: 30,
    retryBackoff: true,
    expireInSeconds: 60 * 40, // одна попытка — до 40 минут
    deadLetter: QUEUES.processMeetingDlq,
    retentionSeconds: 60 * 60 * 24 * 7,
  });
  await b.createQueue(QUEUES.notify, { retryLimit: 5, retryDelay: 15, retryBackoff: true, expireInSeconds: 60 });
  await b.createQueue(QUEUES.audioSweep, { retryLimit: 1, expireInSeconds: 60 * 10 });
  await b.createQueue(QUEUES.stuckSweep, { retryLimit: 1, expireInSeconds: 60 * 5 });
  await b.createQueue(QUEUES.taskReminders, { retryLimit: 1, expireInSeconds: 60 * 5 });
  await b.createQueue(QUEUES.subscriptionsSync, { retryLimit: 1, expireInSeconds: 60 * 15 });
  boss = b;
  return b;
}

export async function enqueueProcessMeeting(job: ProcessMeetingJob): Promise<string | null> {
  const b = await getBoss();
  // singletonKey: не более одного активного job на встречу
  return b.send(QUEUES.processMeeting, job, { singletonKey: job.meetingId });
}

export async function enqueueNotify(job: NotifyJob) {
  const b = await getBoss();
  return b.send(QUEUES.notify, job);
}

export async function stopBoss() {
  if (boss) {
    await boss.stop({ graceful: true, timeout: 30_000 });
    boss = null;
  }
}
