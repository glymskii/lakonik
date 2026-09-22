import { Resend } from "resend";
import { config } from "../config.js";
import { logger } from "../logger.js";

export interface Mail {
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
  attachments?: { filename: string; content: Buffer }[];
}

let client: Resend | null = null;

/** Отправка письма через Resend. Без ключа — пишем в лог (режим разработки). */
export async function sendMail(mail: Mail): Promise<void> {
  const cfg = config();
  if (!cfg.RESEND_API_KEY) {
    logger.warn({ to: mail.to, subject: mail.subject, text: mail.text }, "RESEND_API_KEY не задан — письмо не отправлено (dev)");
    return;
  }
  client ??= new Resend(cfg.RESEND_API_KEY);
  const { error } = await client.emails.send({
    from: cfg.EMAIL_FROM,
    to: Array.isArray(mail.to) ? mail.to : [mail.to],
    subject: mail.subject,
    html: mail.html,
    text: mail.text,
    attachments: mail.attachments?.map((a) => ({ filename: a.filename, content: a.content })),
  });
  if (error) throw new Error(`Resend: ${error.message}`);
}

export function inviteEmail(orgName: string, inviterName: string, link: string) {
  return {
    subject: `${inviterName} приглашает вас в «${orgName}» — Lakonik`,
    text: `${inviterName} приглашает вас в организацию «${orgName}» в Lakonik.\n\nОткройте ссылку на iPhone с установленным приложением: ${link}\n\nЕсли приложения ещё нет — установите Lakonik и откройте ссылку снова. Приглашение действует 14 дней.`,
    html: `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:480px;margin:0 auto;padding:24px">
  <h2 style="margin:0 0 16px">Приглашение в «${orgName}»</h2>
  <p>${inviterName} приглашает вас в организацию в Lakonik — записи встреч, расшифровки, отчёты и задачи команды.</p>
  <p style="margin:24px 0"><a href="${link}" style="background:#1f6fe5;color:#fff;padding:12px 20px;border-radius:10px;text-decoration:none;font-weight:600">Принять приглашение</a></p>
  <p style="color:#555">Откройте ссылку на iPhone с установленным приложением. Если приложения ещё нет — установите Lakonik и откройте ссылку снова. Приглашение действует 14 дней.</p>
</div>`,
  };
}

export function otpEmail(otp: string) {
  return {
    subject: `${otp} — код входа в Lakonik`,
    text: `Ваш код входа: ${otp}\nКод действует 5 минут. Если вы не запрашивали вход — проигнорируйте письмо.`,
    html: `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:480px;margin:0 auto;padding:24px">
  <h2 style="margin:0 0 16px">Код входа в Lakonik</h2>
  <div style="font-size:32px;letter-spacing:8px;font-weight:700;padding:16px 0">${otp}</div>
  <p style="color:#555">Код действует 5 минут. Если вы не запрашивали вход — просто проигнорируйте это письмо.</p>
</div>`,
  };
}
