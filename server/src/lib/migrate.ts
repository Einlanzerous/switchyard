// Run drizzle-generated migrations, apply triggers.sql, then run seed.
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
  const redacted = env.DATABASE_URL.replace(/:\/\/[^@]*@/, "://***@");
  console.log("[migrate] connecting:", redacted);
  const client = postgres(env.DATABASE_URL, { max: 1 });
  const db = drizzle(client);

  try {
    console.log("[migrate] running drizzle migrations from", migrationsFolder);
    await migrate(db, { migrationsFolder });

    console.log("[migrate] applying triggers.sql");
    const sql = readFileSync(triggersFile, "utf8");
    await client.unsafe(sql);

    // Seed needs the live `db` from src/db.ts, which uses its own pooled client.
    // Migrations and seed don't need to share a connection; close the migrator
    // client first, then run seed via the standard module.
    await client.end();

    console.log("[migrate] running seed");
    const { seed } = await import("./seed.js");
    await seed();

    console.log("[migrate] done");
  } catch (err) {
    await client.end().catch(() => {});
    throw err;
  }
}

main().catch((err) => {
  console.error("[migrate] failed:", err);
  process.exit(1);
});
