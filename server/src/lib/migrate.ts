// Run drizzle-generated migrations, then apply triggers.sql.
// Used as the container entrypoint and as `bun run db:migrate`.
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { env } from "../env.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsFolder = resolve(__dirname, "../../drizzle/migrations");
const triggersFile = resolve(__dirname, "../../drizzle/triggers.sql");

async function main() {
  console.log("[migrate] connecting:", env.DATABASE_URL.replace(/:\/\/[^@]*@/, "://***@"));
  const client = postgres(env.DATABASE_URL, { max: 1 });
  const db = drizzle(client);

  try {
    console.log("[migrate] running drizzle migrations from", migrationsFolder);
    await migrate(db, { migrationsFolder });

    console.log("[migrate] applying triggers.sql");
    const sql = readFileSync(triggersFile, "utf8");
    await client.unsafe(sql);

    console.log("[migrate] done");
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error("[migrate] failed:", err);
  process.exit(1);
});
