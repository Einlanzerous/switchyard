// Test DB client. Distinct from src/db.ts — never connects to DATABASE_URL,
// only DATABASE_URL_TEST. Tests refuse to run if the test URL is missing,
// rather than risk touching the dev/prod database.
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../drizzle/schema.js";

const url = process.env.DATABASE_URL_TEST;
if (!url) {
  throw new Error(
    "DATABASE_URL_TEST must be set for tests. " +
      "Create switchyard_test (one-time) and run `bun run db:test:setup`."
  );
}

const client = postgres(url, { max: 5, prepare: false });
export const testDb = drizzle(client, { schema });
export { schema };

export async function closeTestDb(): Promise<void> {
  await client.end({ timeout: 5 });
}
