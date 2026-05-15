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

// Phase-timed startup logging. Each phase prints `[migrate] <phase> took
// Xms` so deploy logs make it obvious where the seconds go. If a migration
// or trigger pass blows up, the line just before the failure points at the
// guilty phase.
function timed<T>(phase: string, fn: () => Promise<T>): Promise<T> {
  const start = Date.now();
  return fn().then((v) => {
    console.log(`[migrate] ${phase} took ${Date.now() - start}ms`);
    return v;
  });
}

async function main() {
  const overallStart = Date.now();
  const redacted = env.DATABASE_URL.replace(/:\/\/[^@]*@/, "://***@");
  console.log("[migrate] connecting:", redacted);
  const client = postgres(env.DATABASE_URL, { max: 1 });
  const db = drizzle(client);

  try {
    await timed("drizzle migrate", () => migrate(db, { migrationsFolder }));

    await timed("triggers.sql", async () => {
      const sql = readFileSync(triggersFile, "utf8");
      await client.unsafe(sql);
    });

    // Seed needs the live `db` from src/db.ts, which uses its own pooled client.
    // Migrations and seed don't need to share a connection; close the migrator
    // client first, then run seed via the standard module.
    await client.end();

    await timed("seed", async () => {
      const { seed } = await import("./seed.js");
      await seed();
    });

    console.log(`[migrate] done in ${Date.now() - overallStart}ms`);
  } catch (err) {
    await client.end().catch(() => {});
    throw err;
  }
}

main().catch((err) => {
  console.error("[migrate] failed:", err);
  process.exit(1);
});
