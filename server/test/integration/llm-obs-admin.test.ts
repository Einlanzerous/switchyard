// Phase 5.1.2 integration tests: warn-list admin endpoints (Admin →
// Observability). Lists unknown dimension values and resolves them
// (promote/reject = UI-resolution-only — no write-path enforcement yet).
//
//   DATABASE_URL_TEST=postgres://...:5432/switchyard_test \
//     bun --cwd server test test/integration/llm-obs-admin.test.ts

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { closeTestDb, schema, testDb } from "../db.js";

process.env.DATABASE_URL = process.env.DATABASE_URL_TEST!;

const { OpenAPIHono } = await import("@hono/zod-openapi");
const { installErrorHandler } = await import("../../src/errors.js");
const { mountRoutes } = await import("../../src/routes/index.js");
const { generateApiToken } = await import("../../src/lib/id.js");

const app = (() => {
  const a = new OpenAPIHono();
  installErrorHandler(a);
  mountRoutes(a);
  return a;
})();

afterAll(async () => {
  await closeTestDb();
});

beforeEach(async () => {
  await testDb.execute(
    sql`TRUNCATE llm_obs_pending_values, api_tokens, users RESTART IDENTITY CASCADE`,
  );
});

async function mintToken(opts: { type: "agent" | "human"; scopes: string[] }): Promise<string> {
  const [user] = await testDb
    .insert(schema.users)
    .values({ name: `u-${Math.random().toString(36).slice(2, 8)}`, type: opts.type })
    .returning();
  const { token, hash, prefix } = generateApiToken();
  await testDb.insert(schema.apiTokens).values({
    user_id: user!.id, name: "test", hashed_token: hash, token_prefix: prefix, scopes: opts.scopes,
  });
  return token;
}

async function seedPending(
  dimension: string, value: string, o: { count?: number; secondsAgo?: number; resolved?: "promoted" | "rejected" } = {},
) {
  const lastSeen = new Date(Date.now() - (o.secondsAgo ?? 0) * 1000).toISOString();
  const [row] = await testDb
    .insert(schema.llmObsPendingValues)
    .values({
      dimension, value,
      observation_count: o.count ?? 1,
      last_seen_at: lastSeen,
      resolved_at: o.resolved ? new Date().toISOString() : null,
      resolution: o.resolved ?? null,
    })
    .returning();
  return row!;
}

const GET = (path: string, token: string) =>
  app.request(path, { headers: { authorization: `Bearer ${token}` } });
const POST = (path: string, token: string) =>
  app.request(path, { method: "POST", headers: { authorization: `Bearer ${token}` } });

describe("GET /v1/admin/llm-obs/pending-values", () => {
  test("lists unresolved by default, newest first; filters by dimension; include_resolved", async () => {
    const admin = await mintToken({ type: "agent", scopes: ["admin"] });
    await seedPending("model", "gpt-5-turbo", { secondsAgo: 10 });
    await seedPending("provider", "openrouter", { secondsAgo: 5 });
    await seedPending("model", "old-promoted", { resolved: "promoted" });

    const def = await (await GET("/v1/admin/llm-obs/pending-values", admin)).json();
    expect(def.items).toHaveLength(2); // resolved one excluded
    expect(def.items[0].value).toBe("openrouter"); // newest last_seen first

    const byDim = await (await GET("/v1/admin/llm-obs/pending-values?dimension=model", admin)).json();
    expect(byDim.items).toHaveLength(1);
    expect(byDim.items[0].value).toBe("gpt-5-turbo");

    const all = await (await GET("/v1/admin/llm-obs/pending-values?include_resolved=true", admin)).json();
    expect(all.items).toHaveLength(3);
  });

  test("non-admin token → 403", async () => {
    const reader = await mintToken({ type: "human", scopes: ["read"] });
    const res = await GET("/v1/admin/llm-obs/pending-values", reader);
    expect(res.status).toBe(403);
  });
});

describe("POST /v1/admin/llm-obs/pending-values/:id/{promote,reject}", () => {
  test("promote resolves the row and drops it from the default list", async () => {
    const admin = await mintToken({ type: "agent", scopes: ["admin"] });
    const row = await seedPending("model", "gpt-5-turbo");

    const res = await POST(`/v1/admin/llm-obs/pending-values/${row.id}/promote`, admin);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.resolution).toBe("promoted");
    expect(body.resolved_at).not.toBeNull();

    const list = await (await GET("/v1/admin/llm-obs/pending-values", admin)).json();
    expect(list.items).toHaveLength(0);
  });

  test("reject resolves with rejected", async () => {
    const admin = await mintToken({ type: "agent", scopes: ["admin"] });
    const row = await seedPending("provider", "sketchy");
    const body = await (await POST(`/v1/admin/llm-obs/pending-values/${row.id}/reject`, admin)).json();
    expect(body.resolution).toBe("rejected");
  });

  test("unknown id → 404", async () => {
    const admin = await mintToken({ type: "agent", scopes: ["admin"] });
    const res = await POST(
      "/v1/admin/llm-obs/pending-values/00000000-0000-0000-0000-000000000000/promote",
      admin,
    );
    expect(res.status).toBe(404);
  });
});
