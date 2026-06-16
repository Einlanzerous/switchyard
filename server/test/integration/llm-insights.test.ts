// Phase 5.1.2 integration tests: LLM Insights read endpoints (KPI strip +
// token spend). Drives the real Hono app over HTTP against the daily rollup.
//
//   DATABASE_URL_TEST=postgres://...:5432/switchyard_test \
//     bun --cwd server test test/integration/llm-insights.test.ts
//
// Covers:
//   - KPI strip aggregates the current window + WoW cost delta, p95 (call-
//     weighted), error rate, cache-hit rate from llm_observations_daily
//   - token-spend groups daily rows into one series per (model, provider)
//   - ?project= filters via the ticket→project join and excludes ambient
//     (ticket_id NULL) rows; the global (unfiltered) view includes them

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
    sql`TRUNCATE llm_observations_daily, llm_observations, model_pricing,
        tickets, project_counters, statuses, projects, api_tokens, users
        RESTART IDENTITY CASCADE`,
  );
});

async function mintAgentToken(): Promise<{ token: string; userId: string }> {
  const [user] = await testDb
    .insert(schema.users)
    .values({ name: "n8n-cogitation", type: "agent" })
    .returning();
  const { token, hash, prefix } = generateApiToken();
  await testDb.insert(schema.apiTokens).values({
    user_id: user!.id,
    name: "test",
    hashed_token: hash,
    token_prefix: prefix,
    scopes: ["read"],
  });
  return { token, userId: user!.id };
}

async function seedPricing() {
  await testDb.insert(schema.modelPricing).values({
    model: "claude-opus-4-7", provider: "anthropic",
    input_usd_per_mtok: 15, output_usd_per_mtok: 75,
    cache_creation_multiplier: 1.25, cache_read_multiplier: 0.1,
    effective_from: "2026-01-01T00:00:00Z", effective_to: null,
  });
}

type RawObsOverrides = Partial<typeof schema.llmObservations.$inferInsert>;
function rawObs(actorId: string, o: RawObsOverrides): typeof schema.llmObservations.$inferInsert {
  return {
    occurred_at: dayAgo(1),
    actor_id: actorId,
    service: "servo-signal",
    operation: "greenfield",
    model: "claude-opus-4-7",
    provider: "anthropic",
    input_tokens: 1_000_000, // 1M × $15 = $15
    output_tokens: 0,
    latency_ms: 200,
    ...o,
  };
}

// In-progress ticket whose updated_at is `hoursAgo` old (the in_progress proxy).
async function seedInProgressTicket(key: string, hoursAgo: number) {
  const [project] = await testDb.insert(schema.projects).values({ key, name: `${key} test` }).returning();
  await testDb.insert(schema.projectCounters).values({ project_id: project!.id });
  const [ip] = await testDb
    .insert(schema.statuses)
    .values({ project_id: project!.id, category: "in_progress", display_name: "In Progress", position: 0, is_default: true })
    .returning();
  const [reporter] = await testDb.insert(schema.users).values({ name: `rep-${key}`, type: "human" }).returning();
  const updatedAt = new Date(Date.now() - hoursAgo * 3_600_000).toISOString();
  const [ticket] = await testDb
    .insert(schema.tickets)
    .values({ project_id: project!.id, number: 1, key: `${key}-1`, title: "t", type: "task", reporter_id: reporter!.id, status_id: ip!.id, updated_at: updatedAt })
    .returning();
  return { project: project!, ticket: ticket! };
}

async function seedTicket(key = "OBS") {
  const [project] = await testDb
    .insert(schema.projects)
    .values({ key, name: `${key} test` })
    .returning();
  await testDb.insert(schema.projectCounters).values({ project_id: project!.id });
  const [backlog] = await testDb
    .insert(schema.statuses)
    .values({ project_id: project!.id, category: "backlog", display_name: "Backlog", position: 0, is_default: true })
    .returning();
  const [reporter] = await testDb
    .insert(schema.users)
    .values({ name: `reporter-${key}`, type: "human" })
    .returning();
  const [ticket] = await testDb
    .insert(schema.tickets)
    .values({ project_id: project!.id, number: 1, key: `${key}-1`, title: "t", type: "task", reporter_id: reporter!.id, status_id: backlog!.id })
    .returning();
  return { project: project!, ticket: ticket! };
}

const dayAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

type DailyOverrides = Partial<typeof schema.llmObservationsDaily.$inferInsert>;
function daily(o: DailyOverrides): typeof schema.llmObservationsDaily.$inferInsert {
  return {
    bucket_date: dayAgo(1),
    service: "servo-signal",
    operation: "greenfield",
    model: "claude-opus-4-7",
    provider: "anthropic",
    actor_id: null,
    ticket_id: null,
    call_count: 1,
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_tokens: 0,
    cache_read_tokens: 0,
    sum_latency_ms: 0,
    p50_latency_ms: 0,
    p95_latency_ms: 0,
    p99_latency_ms: 0,
    cost_usd_at_rollup: 0,
    error_count: 0,
    ...o,
  };
}

function GET(path: string, token: string) {
  return app.request(path, { headers: { authorization: `Bearer ${token}` } });
}

describe("GET /v1/stats/llm/kpi", () => {
  test("aggregates current window + WoW delta + rates", async () => {
    const { token } = await mintAgentToken();
    const { ticket } = await seedTicket();
    await testDb.insert(schema.llmObservationsDaily).values([
      // current window (last 7d)
      daily({
        bucket_date: dayAgo(1), ticket_id: ticket.id,
        call_count: 100, cost_usd_at_rollup: 5, error_count: 4,
        input_tokens: 1000, cache_creation_tokens: 200, cache_read_tokens: 800,
        p95_latency_ms: 300,
      }),
      // prior window (7–14d ago) — only its cost feeds the delta baseline
      daily({ bucket_date: dayAgo(9), ticket_id: ticket.id, call_count: 50, cost_usd_at_rollup: 4 }),
    ]);

    const res = await GET("/v1/stats/llm/kpi", token);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.call_count).toBe(100);
    expect(body.cost_usd).toBeCloseTo(5, 4);
    expect(body.cost_delta_pct).toBeCloseTo(25, 4); // (5-4)/4
    expect(body.p95_latency_ms).toBe(300); // call-weighted, single bucket
    expect(body.error_rate_pct).toBeCloseTo(4, 4); // 4/100
    expect(body.cache_hit_rate_pct).toBeCloseTo(40, 4); // 800/(1000+200+800)
  });

  test("no baseline → null cost delta; no tokens → null cache hit rate", async () => {
    const { token } = await mintAgentToken();
    const { ticket } = await seedTicket();
    await testDb.insert(schema.llmObservationsDaily).values([
      daily({ bucket_date: dayAgo(1), ticket_id: ticket.id, call_count: 10, cost_usd_at_rollup: 2 }),
    ]);
    const body = await (await GET("/v1/stats/llm/kpi", token)).json();
    expect(body.cost_delta_pct).toBeNull();
    expect(body.cache_hit_rate_pct).toBeNull();
  });

  test("?project= filters via ticket→project and excludes ambient", async () => {
    const { token } = await mintAgentToken();
    const { ticket } = await seedTicket("AAA");
    await testDb.insert(schema.llmObservationsDaily).values([
      daily({ bucket_date: dayAgo(1), ticket_id: ticket.id, call_count: 10 }),
      daily({ bucket_date: dayAgo(1), ticket_id: null, call_count: 99 }), // ambient
    ]);

    const scoped = await (await GET("/v1/stats/llm/kpi?project=AAA", token)).json();
    expect(scoped.call_count).toBe(10); // ambient excluded

    const global = await (await GET("/v1/stats/llm/kpi", token)).json();
    expect(global.call_count).toBe(109); // ambient included (instance-wide actor)
  });
});

describe("GET /v1/stats/llm/token-spend", () => {
  test("groups daily rows into one series per (model, provider)", async () => {
    const { token } = await mintAgentToken();
    await testDb.insert(schema.llmObservationsDaily).values([
      daily({ bucket_date: dayAgo(2), model: "claude-opus-4-7", provider: "anthropic", input_tokens: 1000, output_tokens: 200, cost_usd_at_rollup: 3 }),
      daily({ bucket_date: dayAgo(2), model: "gemma4:31b", provider: "ollama", input_tokens: 5000, output_tokens: 400, cost_usd_at_rollup: 0.01 }),
    ]);

    const body = await (await GET("/v1/stats/llm/token-spend", token)).json();
    expect(body.bucket).toBe("week");
    expect(body.series).toHaveLength(2);
    const opus = body.series.find((s: { model: string }) => s.model === "claude-opus-4-7");
    expect(opus).toBeDefined();
    expect(opus.provider).toBe("anthropic");
    expect(opus.points[0].input_tokens).toBe(1000);
    expect(opus.points[0].cost_usd).toBeCloseTo(3, 4);
  });
});

describe("GET /v1/stats/llm/cost-leaderboard", () => {
  test("ranks tickets by cost, with TicketSummary and an Ambient bucket", async () => {
    const { token, userId } = await mintAgentToken();
    await seedPricing();
    const { ticket } = await seedTicket("LDR");
    await testDb.insert(schema.llmObservations).values([
      rawObs(userId, { ticket_id: ticket.id }), // $15
      rawObs(userId, { ticket_id: ticket.id }), // $15 → ticket total $30
      rawObs(userId, { ticket_id: null }), // ambient $15
    ]);

    const body = await (await GET("/v1/stats/llm/cost-leaderboard", token)).json();
    expect(body.items).toHaveLength(2);
    // Highest cost first = the ticket ($30), then ambient ($15).
    expect(body.items[0].cost_usd).toBeCloseTo(30, 4);
    expect(body.items[0].call_count).toBe(2);
    expect(body.items[0].ticket.key).toBe("LDR-1");
    expect(body.items[1].ticket).toBeNull(); // ambient bucket
    expect(body.items[1].cost_usd).toBeCloseTo(15, 4);
  });
});

describe("GET /v1/stats/llm/latency", () => {
  test("call-weighted percentiles per (model, operation)", async () => {
    const { token } = await mintAgentToken();
    await testDb.insert(schema.llmObservationsDaily).values([
      daily({ bucket_date: dayAgo(2), operation: "greenfield", call_count: 100, p50_latency_ms: 200, p95_latency_ms: 400, p99_latency_ms: 500 }),
      daily({ bucket_date: dayAgo(3), operation: "greenfield", call_count: 100, p50_latency_ms: 400, p95_latency_ms: 800, p99_latency_ms: 900 }),
    ]);
    const body = await (await GET("/v1/stats/llm/latency", token)).json();
    const row = body.rows.find((r: { operation: string }) => r.operation === "greenfield");
    expect(row.call_count).toBe(200);
    expect(row.p50_ms).toBe(300); // (200*100 + 400*100)/200
    expect(row.p95_ms).toBe(600);
  });
});

describe("GET /v1/stats/llm/error-rate", () => {
  test("time-bucketed totals from daily + by-code breakdown from raw", async () => {
    const { token, userId } = await mintAgentToken();
    await testDb.insert(schema.llmObservationsDaily).values([
      daily({ bucket_date: dayAgo(2), call_count: 100, error_count: 5 }),
    ]);
    await testDb.insert(schema.llmObservations).values([
      rawObs(userId, { occurred_at: dayAgo(2), error_code: "rate_limited" }),
      rawObs(userId, { occurred_at: dayAgo(2), error_code: "rate_limited" }),
      rawObs(userId, { occurred_at: dayAgo(2), error_code: "timeout" }),
    ]);
    const body = await (await GET("/v1/stats/llm/error-rate", token)).json();
    expect(body.total_calls).toBe(100);
    expect(body.error_calls).toBe(5);
    expect(body.by_code[0]).toEqual({ error_code: "rate_limited", count: 2 });
    expect(body.by_code.find((c: { error_code: string }) => c.error_code === "timeout").count).toBe(1);
  });
});

describe("GET /v1/stats/llm/hitl-stalls", () => {
  test("flags in_progress tickets with no recent LLM activity", async () => {
    const { token } = await mintAgentToken();
    // 48h in_progress, no observations → stalled (defaults: 24h / 4h).
    await seedInProgressTicket("STL", 48);
    const body = await (await GET("/v1/stats/llm/hitl-stalls", token)).json();
    expect(body.threshold_in_progress_hours).toBe(24);
    expect(body.items).toHaveLength(1);
    expect(body.items[0].ticket.key).toBe("STL-1");
    expect(body.items[0].last_llm_activity).toBeNull();
    expect(body.items[0].hours_in_progress).toBeGreaterThan(40);
  });

  test("recent LLM activity clears the stall", async () => {
    const { token, userId } = await mintAgentToken();
    const { ticket } = await seedInProgressTicket("FRESH", 48);
    // A model call 1h ago (within the 4h silent window) → not stalled.
    await testDb.insert(schema.llmObservations).values([
      rawObs(userId, { ticket_id: ticket.id, occurred_at: new Date(Date.now() - 3_600_000).toISOString() }),
    ]);
    const body = await (await GET("/v1/stats/llm/hitl-stalls", token)).json();
    expect(body.items).toHaveLength(0);
  });
});
