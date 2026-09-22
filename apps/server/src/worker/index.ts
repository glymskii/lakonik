import { config } from "../config.js";
import { logger } from "../logger.js";
import { closeDb } from "../db/client.js";
import { getBoss, QUEUES, stopBoss, type NotifyJob, type ProcessMeetingJob } from "../queue/boss.js";
import { markFailedFromDlq, processMeeting } from "../pipeline/process-meeting.js";
import { sweepAudio, sweepStuck } from "../pipeline/sweeps.js";
import { notifyMeeting, sendTaskReminders } from "../push/apns.js";
import { flushSentry, initSentry } from "../observability/sentry.js";
import { flush as flushAnalytics } from "../analytics/amplitude.js";
import { syncStaleSubscriptions } from "../billing/apple.js";

process.env.SERVICE_NAME ??= "worker";

async function main() {
  config();
  initSentry("worker");
  const boss = await getBoss();

  await boss.work<ProcessMeetingJob>(QUEUES.processMeeting, { batchSize: 1, pollingIntervalSeconds: 2 }, async ([job]) => {
    if (!job) return;
    logger.info({ jobId: job.id, meetingId: job.data.meetingId, regenerate: !!job.data.regenerate }, "Обработка встречи");
    await processMeeting(job.data);
  });

  await boss.work<ProcessMeetingJob>(QUEUES.processMeetingDlq, { batchSize: 1, pollingIntervalSeconds: 10 }, async ([job]) => {
    if (!job) return;
    await markFailedFromDlq(job.data, "попытки исчерпаны");
  });

  await boss.work<NotifyJob>(QUEUES.notify, { batchSize: 1, pollingIntervalSeconds: 2 }, async ([job]) => {
    if (!job) return;
    await notifyMeeting(job.data);
  });

  await boss.work(QUEUES.audioSweep, { batchSize: 1, pollingIntervalSeconds: 30 }, async () => {
    await sweepAudio();
  });
  await boss.work(QUEUES.stuckSweep, { batchSize: 1, pollingIntervalSeconds: 30 }, async () => {
    await sweepStuck();
  });

  await boss.work(QUEUES.taskReminders, { batchSize: 1, pollingIntervalSeconds: 30 }, async () => {
    await sendTaskReminders();
  });

  await boss.work(QUEUES.subscriptionsSync, { batchSize: 1, pollingIntervalSeconds: 60 }, async () => {
    await syncStaleSubscriptions();
  });

  await boss.schedule(QUEUES.taskReminders, "5 * * * *"); // каждый час; отправка только в remindHourLocal по Алматы
  await boss.schedule(QUEUES.audioSweep, "15 * * * *"); // каждый час
  await boss.schedule(QUEUES.stuckSweep, "*/10 * * * *"); // каждые 10 минут
  await boss.schedule(QUEUES.subscriptionsSync, "40 3 * * *"); // раз в сутки: подписки без уведомлений дольше 24 ч

  logger.info("Worker запущен: очереди meeting.process, notify, sweeps, billing.sync");

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "Останавливаю worker…");
    await Promise.all([flushSentry(), flushAnalytics()]);
    await stopBoss();
    await closeDb();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((e) => {
  logger.error(e, "Worker не запустился");
  process.exit(1);
});
