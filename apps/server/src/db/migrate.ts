import { migrate } from "drizzle-orm/node-postgres/migrator";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { closeDb, db } from "./client.js";
import { backfillOrganizations } from "./organizations.js";
import { logger } from "../logger.js";

async function main() {
  const [v] = (await db().execute(sql`select version()`)).rows as { version: string }[];
  logger.info({ postgres: v?.version?.split(" on ")[0] }, "Применяю миграции…");
  await migrate(db(), { migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)) });
  logger.info("Миграции применены");
  await backfillOrganizations();
  await closeDb();
}

main().catch((e) => {
  logger.error(e, "Ошибка миграции");
  process.exit(1);
});
