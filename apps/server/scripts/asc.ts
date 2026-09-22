/**
 * App Store Connect API: статус сборок TestFlight и внутренняя группа тестировщиков.
 *   tsx scripts/asc.ts builds                 — последние сборки приложения и их статус
 *   tsx scripts/asc.ts group [название]       — создать внутреннюю группу (доступ ко всем сборкам), вывести её id
 *   tsx scripts/asc.ts testers                — список бета-тестеров
 *   tsx scripts/asc.ts add <groupId> <email>  — добавить тестера в группу (внешние группы)
 *   tsx scripts/asc.ts invite <email…>        — отправить (повторно) приглашение TestFlight тестеру со статусом NOT_INVITED
 *   tsx scripts/asc.ts crashes [n]            — крэш-фидбек из TestFlight: список и текст n последних крэш-логов (по умолчанию 1)
 *   tsx scripts/asc.ts bundle-ids             — App ID команды с включёнными capabilities
 *   tsx scripts/asc.ts app-groups <bundleId…> — зарегистрировать App ID (если нет) и включить capability App Groups
 * Нужны переменные ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_PATH (или ~/Documents/asc-api.json), ASC_APP_ID.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { SignJWT, importPKCS8 } from "jose";

const cfgFile = `${homedir()}/Documents/asc-api.json`;
const file = (() => { try { return JSON.parse(readFileSync(cfgFile, "utf8")); } catch { return {}; } })();
const KEY_ID = process.env.ASC_KEY_ID ?? file.keyId;
const ISSUER = process.env.ASC_ISSUER_ID ?? file.issuerId;
const KEY_PATH = process.env.ASC_KEY_PATH ?? file.keyPath;
const APP_ID = process.env.ASC_APP_ID ?? "6812003830";

async function token() {
  const key = await importPKCS8(readFileSync(KEY_PATH, "utf8"), "ES256");
  return new SignJWT({ aud: "appstoreconnect-v1" }).setProtectedHeader({ alg: "ES256", kid: KEY_ID, typ: "JWT" }).setIssuer(ISSUER).setIssuedAt().setExpirationTime("15m").sign(key);
}

async function api(method: string, path: string, body?: unknown) {
  const res = await fetch(`https://api.appstoreconnect.apple.com/v1${path}`, {
    method,
    headers: { Authorization: `Bearer ${await token()}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* пусто */ }
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 600)}`);
  return json;
}

const [cmd, ...args] = process.argv.slice(2);

if (cmd === "builds") {
  const r = await api("GET", `/builds?filter[app]=${APP_ID}&sort=-uploadedDate&limit=5&fields[builds]=version,processingState,uploadedDate,expired,usesNonExemptEncryption`);
  for (const b of r.data) console.log(`build ${b.attributes.version} — ${b.attributes.processingState} — uploaded ${b.attributes.uploadedDate}${b.attributes.expired ? " (expired)" : ""}`);
  if (!r.data.length) console.log("сборок пока нет");
} else if (cmd === "group") {
  const name = args[0] ?? "ADV Internal";
  const existing = await api("GET", `/betaGroups?filter[app]=${APP_ID}&filter[name]=${encodeURIComponent(name)}`);
  if (existing.data.length) {
    console.log(`группа уже есть: ${existing.data[0].id} (${existing.data[0].attributes.name}, internal=${existing.data[0].attributes.isInternalGroup})`);
  } else {
    const r = await api("POST", "/betaGroups", {
      data: { type: "betaGroups", attributes: { name, isInternalGroup: true, hasAccessToAllBuilds: true }, relationships: { app: { data: { type: "apps", id: APP_ID } } } },
    });
    console.log(`создана группа ${r.data.id} (${r.data.attributes.name}, internal, доступ ко всем сборкам)`);
  }
} else if (cmd === "invite") {
  // Тестер числится в группе, но статус NOT_INVITED и «No Builds Available» — письмо-приглашение не ушло; отправляем явно
  for (const email of args) {
    const r = await api("GET", `/betaTesters?filter[apps]=${APP_ID}&filter[email]=${encodeURIComponent(email)}&fields[betaTesters]=email,state`);
    const t = r.data[0];
    if (!t) { console.log(`${email}: не найден среди тестеров приложения`); continue; }
    await api("POST", "/betaTesterInvitations", { data: { type: "betaTesterInvitations", relationships: { betaTester: { data: { type: "betaTesters", id: t.id } }, app: { data: { type: "apps", id: APP_ID } } } } });
    console.log(`${email}: приглашение отправлено (было ${t.attributes.state})`);
  }
} else if (cmd === "testers") {
  const r = await api("GET", `/betaTesters?filter[apps]=${APP_ID}&limit=50&fields[betaTesters]=email,firstName,lastName,inviteType,state`);
  for (const t of r.data) console.log(`${t.attributes.email} — ${t.attributes.firstName ?? ""} ${t.attributes.lastName ?? ""} — ${t.attributes.inviteType} — ${t.attributes.state}`);
  if (!r.data.length) console.log("тестеров пока нет");
} else if (cmd === "add") {
  const [groupId, email, first = "", last = ""] = args;
  const r = await api("POST", "/betaTesters", {
    data: { type: "betaTesters", attributes: { email, firstName: first || undefined, lastName: last || undefined }, relationships: { betaGroups: { data: [{ type: "betaGroups", id: groupId }] } } },
  });
  console.log(`добавлен тестер ${r.data.attributes.email} (${r.data.id})`);
} else if (cmd === "crashes") {
  const n = Number(args[0] ?? 1);
  const r = await api("GET", `/apps/${APP_ID}/betaFeedbackCrashSubmissions?sort=-createdDate&limit=10&include=build&fields[builds]=version`);
  for (const c of r.data) {
    const a = c.attributes;
    const build = r.included?.find((i: any) => i.id === c.relationships?.build?.data?.id)?.attributes?.version;
    console.log(`${c.id} — ${a.createdDate} — build ${build ?? "?"} — ${a.deviceModel} iOS ${a.osVersion} — «${a.comment ?? ""}»`);
  }
  if (!r.data.length) console.log("крэш-фидбека нет");
  for (const c of r.data.slice(0, n)) {
    const log = await api("GET", `/betaFeedbackCrashSubmissions/${c.id}/crashLog`);
    const attrs = log?.data?.attributes ?? {};
    const text: string = attrs.logText ?? (attrs.url ? await (await fetch(attrs.url)).text() : JSON.stringify(log).slice(0, 800));
    console.log(`\n===== crash log ${c.id} (${text.length} bytes) =====\n${text}`);
  }
} else if (cmd === "bundle-ids") {
  const r = await api("GET", `/bundleIds?filter[platform]=IOS&limit=50&include=bundleIdCapabilities&fields[bundleIdCapabilities]=capabilityType`);
  for (const b of r.data) {
    const caps = (b.relationships?.bundleIdCapabilities?.data ?? []).map((c: any) => r.included?.find((i: any) => i.id === c.id)?.attributes?.capabilityType).filter(Boolean);
    console.log(`${b.id} — ${b.attributes.identifier} — ${b.attributes.name} — [${caps.join(", ")}]`);
  }
} else if (cmd === "app-groups") {
  for (const identifier of args) {
    const existing = await api("GET", `/bundleIds?filter[identifier]=${encodeURIComponent(identifier)}&filter[platform]=IOS&include=bundleIdCapabilities&fields[bundleIdCapabilities]=capabilityType`);
    let b = existing.data.find((x: any) => x.attributes.identifier === identifier);
    if (!b) {
      const created = await api("POST", "/bundleIds", { data: { type: "bundleIds", attributes: { identifier, name: identifier.replace(/[^A-Za-z0-9 ]/g, " ").trim(), platform: "IOS" } } });
      b = created.data;
      console.log(`зарегистрирован App ID ${identifier} (${b.id})`);
    }
    const caps = (b.relationships?.bundleIdCapabilities?.data ?? []).map((c: any) => existing.included?.find((i: any) => i.id === c.id)?.attributes?.capabilityType);
    if (caps.includes("APP_GROUPS")) { console.log(`${identifier}: App Groups уже включены`); continue; }
    await api("POST", "/bundleIdCapabilities", { data: { type: "bundleIdCapabilities", attributes: { capabilityType: "APP_GROUPS" }, relationships: { bundleId: { data: { type: "bundleIds", id: b.id } } } } });
    console.log(`${identifier}: capability App Groups включена`);
  }
} else {
  console.log("команды: builds | group [name] | testers | add <groupId> <email> [first] [last] | crashes [n] | bundle-ids | app-groups <bundleId…>");
}
