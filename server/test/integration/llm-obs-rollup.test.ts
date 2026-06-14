// Phase 5.1.3 integration tests: hourly rollup + retention cleanup.
//
//   DATABASE_URL_TEST=postgres://...:5432/switchyard_test \
//     bun --cwd server test test/integration/llm-obs-rollup.test.ts
//
// Covers:
//   - raw observations aggregate into llm_observations_daily (counts, token
//     sums, frozen cost, error count, latency percentiles)
//   - NULL-dimension rows (ambient: ticket_id NULL) roll into their own bucket
//   - re-roll is idempotent (delete-and-reinsert, no duplicate daily rows)
//   - retention deletes raw rows past llm_obs_retention_days, keeps daily
//   - retention floor: a row inside the re-roll window is never deleted, even
//     when the retention setting is smaller than the window

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { closeTestDb, schema, testDb } from "../db.js";

process.env.DATABASE_URL = process.env.DATABASE_URL_TEST!;

// Lazy import AFTER pointing DATABASE_URL at the test DB so the module's
// prod-db singleton binds cleanly; we drive it with testDb regardless.
const { _runOnce } = await import("../../src/lib/llm-obs/rollup.js");

const PRICED_FROM = "2026-01-01T00:00:00Z";
const nowIso = () => new Date().toISOString();
const daysAgoIso = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();

afterAll(async () => {
  await closeTestDb();
});

beforeEach(async () => {
  await testDb.execute(
    sql`TRUNCATE llm_observations_daily, llm_observations, model_pricing,
        system_settings, tickets, project_counters, statuses,
        labels, projects, users
        RESTART IDENTITY CASCADE`,
  );
});

async function seedActor() {
  const [user] = await testDb
    .insert(schema.users)
    .values({ name: "n8n-cogitation", type: "agent" })
    .returning();
  return user!;
}

async function seedTokenPricing() {
  await testDb.insert(schema.modelPricing).values({
    model: "claude-opus-4-7",
    provider: "anthropic",
    input_usd_per_mtok: 15.0,
    output_usd_per_mtok: 75.0,
    cache_creation_multiplier: 1.25,
    cache_read_multiplier: 0.1,
    effective_from: PRICED_FROM,
    effective_to: null,
  });
}

type ObsOverrides = Partial<typeof schema.llmObservations.$inferInsert>;
function obs(actorId: string, o: ObsOverrides = {}): typeof schema.llmObservations.$inferInsert {
  return {
    occurred_at: nowIso(),
    actor_id: actorId,
    service: "servo-signal",
    operation: "greenfield",
    model: "claude-opus-4-7",
    provider: "anthropic",
    input_tokens: 1_000_000, // 1M × $15 = $15 each (output 0)
    output_tokens: 0,
    latency_ms: 200,
    ...o,
  };
}

async function dailyRows() {
  return (await testDb.execute(
    sql`SELECT * FROM llm_observations_daily ORDER BY ticket_id NULLS LAST`,
  )) as unknown as Array<Record<string, unknown>>;
}

describe("llm-obs rollup", () => {
  test("aggregates raw observations into a daily bucket", async () => {
    const actor = await seedActor();
    await seedTokenPricing();
    // Three calls, same dims → one bucket. Latencies 100/200/300 → p50 = 200.
    await testDb.insert(schema.llmObservations).values([
      obs(actor.id, { latency_ms: 100 }),
      obs(actor.id, { latency_ms: 200 }),
      obs(actor.id, { latency_ms: 300, error_code: "rate_limited" }),
    ]);

    const { rolled } = await _runOnce(testDb);
    expect(rolled).toBe(1);

    const rows = await dailyRows();
    expect(rows).toHaveLength(1);
    const r = rows[0]!;
    expect(Number(r.call_count)).toBe(3);
    expect(Number(r.input_tokens)).toBe(3_000_000);
    expect(Number(r.error_count)).toBe(1);
    expect(Number(r.p50_latency_ms)).toBe(200);
    // 3 × $15 frozen into the bucket.
    expect(Number(r.cost_usd_at_rollup)).toBeCloseTo(45, 4);
  });

  test("ambient (ticket_id NULL) rows roll into their own bucket", async () => {
    const actor = await seedActor();
    await seedTokenPricing();
    await testDb.insert(schema.llmObservations).values([
      obs(actor.id, { operation: "scribe", ticket_id: null }),
      obs(actor.id, { operation: "scribe", ticket_id: null }),
    ]);

    await _runOnce(testDb);
    const rows = await dailyRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.ticket_id).toBeNull();
    expect(Number(rows[0]!.call_count)).toBe(2);
  });

  test("re-roll is idempotent — no duplicate daily rows", async () => {
    const actor = await seedActor();
    await seedTokenPricing();
    await testDb.insert(schema.llmObservations).values([obs(actor.id), obs(actor.id)]);

    await _runOnce(testDb);
    await _runOnce(testDb);

    const rows = await dailyRows();
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]!.call_count)).toBe(2);
  });
});

describe("llm-obs retention", () => {
  test("deletes raw rows past retention, leaves daily rollups untouched", async () => {
    const actor = await seedActor();
    await seedTokenPricing();
    // Recent row (rolled + kept) and a 200-day-old row (past the 180d default).
    await testDb.insert(schema.llmObservations).values([
      obs(actor.id),
      obs(actor.id, { occurred_at: daysAgoIso(200) }),
    ]);
    // A daily rollup from long ago must survive retention forever.
    await testDb.insert(schema.llmObservationsDaily).values({
      bucket_date: daysAgoIso(300),
      service: "servo-signal",
      operation: "greenfield",
      model: "claude-opus-4-7",
      provider: "anthropic",
      actor_id: actor.id,
      ticket_id: null,
      call_count: 1,
      input_tokens: 1,
      output_tokens: 1,
      cache_creation_tokens: 0,
      cache_read_tokens: 0,
      sum_latency_ms: 1,
      p50_latency_ms: 1,
      p95_latency_ms: 1,
      p99_latency_ms: 1,
      cost_usd_at_rollup: 0,
      error_count: 0,
    });

    const { deleted } = await _runOnce(testDb);
    expect(deleted).toBe(1); // only the 200-day-old raw row

    const rawCount = (await testDb.execute(
      sql`SELECT COUNT(*)::int AS n FROM llm_observations`,
    )) as unknown as Array<{ n: number }>;
    expect(Number(rawCount[0]!.n)).toBe(1); // the recent row remains

    const oldDaily = (await testDb.execute(
      sql`SELECT COUNT(*)::int AS n FROM llm_observations_daily WHERE bucket_date < now() - INTERVAL '250 days'`,
    )) as unknown as Array<{ n: number }>;
    expect(Number(oldDaily[0]!.n)).toBe(1); // 300-day-old rollup survives
  });

  test("never deletes a row inside the re-roll window, even at tiny retention", async () => {
    const actor = await seedActor();
    await seedTokenPricing();
    // Retention of 1 day would target everything older than yesterday, but the
    // window floor protects today's still-being-rolled rows.
    await testDb.insert(schema.systemSettings).values({
      key: "llm_obs_retention_days",
      value: 1,
    });
    await testDb.insert(schema.llmObservations).values([obs(actor.id)]); // today

    const { deleted } = await _runOnce(testDb);
    expect(deleted).toBe(0);

    const rawCount = (await testDb.execute(
      sql`SELECT COUNT(*)::int AS n FROM llm_observations`,
    )) as unknown as Array<{ n: number }>;
    expect(Number(rawCount[0]!.n)).toBe(1);
  });
});
