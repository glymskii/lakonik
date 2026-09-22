import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { bearer, emailOTP } from "better-auth/plugins";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { db, schema } from "../db/client.js";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { otpEmail, sendMail } from "../email/mailer.js";
import { emailDomain, isEmailAllowed } from "./allowlist.js";
import { agencies } from "../db/schema/index.js";

async function agencyDomains(): Promise<{ id: string; domains: string[] }[]> {
  const rows = await db().select({ id: agencies.id, domains: agencies.emailDomains }).from(agencies);
  return rows;
}

function buildSocialProviders() {
  const cfg = config();
  const providers: Record<string, unknown> = {};
  if (cfg.GOOGLE_CLIENT_IDS.length > 0) {
    providers.google = {
      clientId: cfg.GOOGLE_CLIENT_IDS.length === 1 ? cfg.GOOGLE_CLIENT_IDS[0] : cfg.GOOGLE_CLIENT_IDS,
      clientSecret: cfg.GOOGLE_CLIENT_SECRET ?? "",
    };
  }
  if (cfg.APPLE_CLIENT_ID && cfg.APPLE_TEAM_ID && cfg.APPLE_KEY_ID && cfg.APPLE_PRIVATE_KEY) {
    // Полная конфигурация (веб-OAuth + нативный вход): Service ID + ключ Sign in with Apple
    providers.apple = async () => ({
      clientId: cfg.APPLE_CLIENT_ID,
      clientSecret: await generateAppleClientSecret(cfg.APPLE_CLIENT_ID!, cfg.APPLE_TEAM_ID!, cfg.APPLE_KEY_ID!, cfg.APPLE_PRIVATE_KEY!),
      appBundleIdentifier: cfg.APPLE_BUNDLE_ID,
    });
  } else {
    // Только нативный вход с iPhone: ID-токен проверяется по JWKS Apple, audience = bundle ID приложения.
    // clientSecret нужен лишь для веб-редиректа, здесь не используется.
    providers.apple = {
      clientId: cfg.APPLE_BUNDLE_ID,
      clientSecret: "native-only",
      appBundleIdentifier: cfg.APPLE_BUNDLE_ID,
    };
  }
  return providers;
}

/** JWT client secret для Sign in with Apple (ES256, срок 6 месяцев). */
async function generateAppleClientSecret(clientId: string, teamId: string, keyId: string, privateKeyPem: string) {
  const { SignJWT, importPKCS8 } = await import("jose");
  const key = await importPKCS8(privateKeyPem.replace(/\\n/g, "\n"), "ES256");
  return new SignJWT({})
    .setProtectedHeader({ alg: "ES256", kid: keyId })
    .setIssuer(teamId)
    .setIssuedAt()
    .setExpirationTime("180d")
    .setAudience("https://appleid.apple.com")
    .setSubject(clientId)
    .sign(key);
}

export function createAuth() {
  const cfg = config();
  return betterAuth({
    appName: "Lakonik",
    baseURL: cfg.BASE_URL,
    basePath: "/api/auth",
    secret: cfg.BETTER_AUTH_SECRET,
    database: drizzleAdapter(db(), {
      provider: "pg",
      schema: {
        user: schema.user,
        session: schema.session,
        account: schema.account,
        verification: schema.verification,
      },
    }),
    trustedOrigins: [cfg.BASE_URL, "https://appleid.apple.com"],
    emailAndPassword: { enabled: false },
    socialProviders: buildSocialProviders() as never,
    user: {
      additionalFields: {
        agencyId: { type: "string", required: false, input: false },
        role: { type: "string", required: false, defaultValue: "member", input: false },
      },
    },
    session: {
      expiresIn: 60 * 60 * 24 * 90, // 90 дней — мобильное приложение
      updateAge: 60 * 60 * 24,
    },
    databaseHooks: {
      user: {
        create: {
          before: async (u) => {
            const domains = await agencyDomains();
            const all = domains.flatMap((d) => d.domains);
            if (!isEmailAllowed(u.email, all)) {
              logger.warn({ email: u.email }, "Регистрация отклонена: домен не в allowlist");
              throw new APIError("FORBIDDEN", {
                message: "Вход доступен только с корпоративной почты вашей организации.",
              });
            }
            const domain = emailDomain(u.email);
            const agency = domains.find((d) => d.domains.map((x) => x.toLowerCase()).includes(domain));
            return { data: { ...u, agencyId: agency?.id ?? null, role: "member" } };
          },
        },
      },
    },
    plugins: [
      bearer(),
      emailOTP({
        otpLength: 6,
        expiresIn: 300,
        allowedAttempts: 5,
        async sendVerificationOTP({ email, otp, type }) {
          if (type !== "sign-in") return;
          const mail = otpEmail(otp);
          await sendMail({ to: email, ...mail });
        },
      }),
    ],
    advanced: {
      // Мобильный клиент: cookie не нужны, работаем по bearer-токену
      useSecureCookies: cfg.NODE_ENV === "production",
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;

let instance: Auth | null = null;
export function auth(): Auth {
  instance ??= createAuth();
  return instance;
}
