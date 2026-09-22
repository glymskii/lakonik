import { z } from "zod";

const bool = z
  .string()
  .optional()
  .transform((v) => v === "true" || v === "1");

const csv = z
  .string()
  .optional()
  .transform((v) =>
    (v ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().default(3000),
  LOG_LEVEL: z.string().default("info"),
  BASE_URL: z.string().url().default("http://localhost:3000"),
  BETTER_AUTH_SECRET: z.string().min(16),

  DATABASE_URL: z.string().min(1),

  S3_ENDPOINT: z.string().url(),
  S3_REGION: z.string().default("auto"),
  S3_BUCKET: z.string().min(1),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
  S3_URL_STYLE: z.enum(["path", "virtual-host"]).default("path"),
  S3_PUBLIC_ENDPOINT: z.string().optional().transform((v) => (v && v.length > 0 ? v : undefined)),

  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default("claude-opus-5"),
  ANTHROPIC_MODEL_DRAFT: z.string().default("claude-sonnet-5"),
  ELEVENLABS_API_KEY: z.string().optional(),
  ELEVENLABS_MODEL_ID: z.string().default("scribe_v2"),
  /** Как отдавать аудио в STT: url — presigned-ссылка (bucket должен быть доступен из интернета), file — байты через multipart, auto — file для localhost/MinIO */
  STT_UPLOAD_MODE: z.enum(["auto", "url", "file"]).default("auto"),

  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().default("Lakonik <noreply@lakonik.app>"),

  ALLOWED_EMAIL_DOMAINS: csv,
  GOOGLE_CLIENT_IDS: csv,
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  APPLE_CLIENT_ID: z.string().optional(),
  APPLE_TEAM_ID: z.string().optional(),
  APPLE_KEY_ID: z.string().optional(),
  APPLE_PRIVATE_KEY: z.string().optional(),
  APPLE_BUNDLE_ID: z.string().default("kz.adv.meetings"),

  APNS_KEY_ID: z.string().optional(),
  APNS_TEAM_ID: z.string().optional(),
  APNS_PRIVATE_KEY: z.string().optional(),
  /** Путь к .p8 (локальная разработка); имеет приоритет над APNS_PRIVATE_KEY */
  APNS_PRIVATE_KEY_FILE: z.string().optional(),
  APNS_BUNDLE_ID: z.string().default("kz.adv.meetings"),
  APNS_PRODUCTION: bool,

  AUDIO_RETENTION_HOURS: z.coerce.number().default(48),
  PIPELINE_STUCK_MINUTES: z.coerce.number().default(30),
  // Для тестов: подменить внешние провайдеры заглушками
  FAKE_PROVIDERS: bool,
});

export type Config = z.infer<typeof schema>;

let cached: Config | null = null;

export function config(): Config {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Некорректная конфигурация окружения:\n${issues}`);
  }
  cached = parsed.data;
  return cached;
}

export const isProd = () => config().NODE_ENV === "production";
