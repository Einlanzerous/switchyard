import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { env } from "./env.js";
import * as schema from "../drizzle/schema.js";

// Single connection pool shared by the process. `prepare: false` because
// pg's prepared-statement cache fights with our migration runner on cold start.
const client = postgres(env.DATABASE_URL, {
  max: 10,
  idle_timeout: 30,
  connect_timeout: 5,
  prepare: false,
});

export const db = drizzle(client, { schema });
export type DB = typeof db;
export { schema };

// Validate connectivity at boot. If this fails, exit non-zero so docker reports
// the failure cleanly instead of staying up with a broken DB connection.
export async function assertDatabaseReachable(): Promise<void> {
  try {
    await client`SELECT 1`;
  } catch (err) {
    console.error("[switchyard] database unreachable:", err);
    process.exit(1);
  }
}

export async function pingDatabase(): Promise<boolean> {
  try {
    await client`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

export async function shutdownDatabase(): Promise<void> {
  await client.end({ timeout: 5 });
}
