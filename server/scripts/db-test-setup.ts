// Apply schema migrations + triggers.sql to the test DB.
// Run once before `bun test`; idempotent.
//
// Prerequisite (one-time, as a Postgres superuser — typically the construct
// `postgres` user):
//
//   CREATE DATABASE switchyard_test OWNER switchyard_user;
//
// After that, `bun run db:test:setup` keeps the test DB schema in sync with
// the dev DB.
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const url = process.env.DATABASE_URL_TEST;
if (!url) {
  console.error("[db:test:setup] DATABASE_URL_TEST must be set");
  process.exit(1);
}

const migrationsFolder = resolve(import.meta.dir, "../drizzle/migrations");
const triggersFile = resolve(import.meta.dir, "../drizzle/triggers.sql");

const client = postgres(url, { max: 1 });
const db = drizzle(client);

try {
  console.log("[db:test:setup] applying drizzle migrations");
  await migrate(db, { migrationsFolder });

  console.log("[db:test:setup] applying triggers.sql");
  await client.unsafe(readFileSync(triggersFile, "utf8"));

  console.log("[db:test:setup] done");
} finally {
  await client.end();
}
