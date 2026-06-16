// SWY-48 Phase 5.1.3 — LLM observation rollup + retention.
//
// Two jobs on one hourly tick (mirrors the external-ref poller's start/stop
// lifecycle):
//
//   1. Rollup — aggregate raw `llm_observations` into `llm_observations_daily`
//      (one row per day × service × operation × model × provider × actor ×
//      ticket). The global Insights tiles read the rollup; per-ticket + HITL
//      tiles read raw. Cost is FROZEN at rollup time (summed from the cost
//      view), so a later pricing change only affects new buckets — no
//      retroactive recompute.
//
//      We re-roll a sliding 2-day window (today + yesterday, UTC) every tick to
//      catch late-arriving observations, via delete-and-reinsert per bucket.
//      That sidesteps the NULL-dimension ON CONFLICT trap (Postgres treats NULL
//      actor_id / ticket_id as distinct) entirely — no migration needed.
//
//   2. Retention — delete raw observations past `llm_obs_retention_days`
//      (default 180). Daily rollups are kept forever. The delete is floored at
//      the re-roll window so a tiny retention setting can never drop a row
//      before it's been frozen into a finalized daily bucket.

import { sql, type SQL } from "drizzle-orm";
import { db } from "../../db.js";

// Both the production `db` and the test `testDb` are the same postgres-js
// drizzle type, so the core jobs accept an executor (default `db`) and tests
// can drive them against the test database.
type Db = typeof db;

const ROLLUP_TICK_MS = 60 * 60 * 1000; // hourly — keeps "today" fresh
const DEFAULT_RETENTION_DAYS = 180;

// Earliest bucket we re-roll each tick: yesterday 00:00 UTC. Everything older is
// immutable once written. Reused by the rollup delete and the retention floor.
const windowStart = sql`((date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') - INTERVAL '1 day')`;

let running = false;
let timer: ReturnType<typeof setInterval> | null = null;
let inflight = 0;

export function startLlmObsRollup(): void {
  if (running) return;
  running = true;
  console.log("[llm-obs-rollup] started");
  timer = setInterval(() => {
    void tick().catch((err) => console.error("[llm-obs-rollup] tick error:", err));
  }, ROLLUP_TICK_MS);
}

export async function stopLlmObsRollup(deadlineMs = 5_000): Promise<void> {
  if (!running) return;
  running = false;
  if (timer) clearInterval(timer);
  timer = null;
  const start = Date.now();
  while (inflight > 0 && Date.now() - start < deadlineMs) {
    await new Promise((r) => setTimeout(r, 50));
  }
  console.log("[llm-obs-rollup] stopped");
}

// Test seam — drives one tick synchronously without waiting for the interval.
// Accepts an executor so tests can run it against the test database.
export async function _runOnce(client: Db = db): Promise<{ rolled: number; deleted: number }> {
  return tick(client);
}

export function _resetForTesting(): void {
  if (timer) clearInterval(timer);
  timer = null;
  running = false;
  inflight = 0;
}

// ─── internals ──────────────────────────────────────────────────────────────

async function tick(client: Db = db): Promise<{ rolled: number; deleted: number }> {
  inflight++;
  try {
    const rolled = await rollupWindow(client);
    const deleted = await cleanupExpired(client);
    return { rolled, deleted };
  } finally {
    inflight--;
  }
}

// Re-roll a window: delete its daily rows, then re-aggregate from raw. Wrapped
// in a txn so the table is never observed half-rebuilt. Defaults to the sliding
// 2-day window (the hourly job); `backfillRollup` passes a wider cutoff.
async function rollupWindow(client: Db, fromCutoff: SQL = windowStart): Promise<number> {
  return client.transaction(async (tx) => {
    await tx.execute(sql`DELETE FROM llm_observations_daily WHERE bucket_date >= ${fromCutoff}`);

    const res = await tx.execute(sql`
      INSERT INTO llm_observations_daily (
        bucket_date, service, operation, model, provider, actor_id, ticket_id,
        call_count, input_tokens, output_tokens,
        cache_creation_tokens, cache_read_tokens,
        sum_latency_ms, p50_latency_ms, p95_latency_ms, p99_latency_ms,
        cost_usd_at_rollup, error_count
      )
      SELECT
        (date_trunc('day', c.occurred_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') AS bucket_date,
        c.service, c.operation, c.model, c.provider, c.actor_id, c.ticket_id,
        COUNT(*)::int,
        COALESCE(SUM(c.input_tokens), 0),
        COALESCE(SUM(c.output_tokens), 0),
        COALESCE(SUM(c.cache_creation_input_tokens), 0),
        COALESCE(SUM(c.cache_read_input_tokens), 0),
        COALESCE(SUM(c.latency_ms), 0),
        COALESCE(percentile_cont(0.5) WITHIN GROUP (ORDER BY c.latency_ms), 0)::int,
        COALESCE(percentile_cont(0.95) WITHIN GROUP (ORDER BY c.latency_ms), 0)::int,
        COALESCE(percentile_cont(0.99) WITHIN GROUP (ORDER BY c.latency_ms), 0)::int,
        -- cost_usd is NULL for unpriced rows; SUM ignores NULLs so they
        -- contribute 0 to the frozen bucket cost.
        COALESCE(SUM(c.cost_usd), 0),
        COUNT(*) FILTER (WHERE c.error_code IS NOT NULL)::int
      FROM llm_observations_with_cost c
      WHERE c.occurred_at >= ${fromCutoff}
      GROUP BY 1, c.service, c.operation, c.model, c.provider, c.actor_id, c.ticket_id
    `);
    return rowCount(res);
  });
}

// One-off backfill over a wider window than the hourly job — used by the dev
// sample seeder so historical observations populate the daily-backed tiles
// (the 2-day sliding window can't reach them). Re-rolls every bucket from
// `days` ago to now.
export async function backfillRollup(client: Db = db, days = 30): Promise<number> {
  return rollupWindow(client, sql`(now() - (${days} * INTERVAL '1 day'))`);
}

// Delete raw rows past retention, floored at the re-roll window so we never
// drop a row that hasn't been frozen into a finalized (older-than-window) day.
async function cleanupExpired(client: Db): Promise<number> {
  const res = await client.execute(sql`
    DELETE FROM llm_observations
    WHERE occurred_at < LEAST(
      now() - (
        COALESCE(
          (SELECT (value #>> '{}')::int FROM system_settings WHERE key = 'llm_obs_retention_days'),
          ${DEFAULT_RETENTION_DAYS}
        ) * INTERVAL '1 day'
      ),
      ${windowStart}
    )
  `);
  return rowCount(res);
}

// `db.execute` returns a postgres result; normalize the affected-row count
// across the driver's `.count` / array-length shapes (see stats.ts note).
function rowCount(res: unknown): number {
  const r = res as { count?: number; rowCount?: number; length?: number };
  return r.count ?? r.rowCount ?? r.length ?? 0;
}
