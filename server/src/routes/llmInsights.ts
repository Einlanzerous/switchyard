// Read-only LLM observability endpoints powering the Insights → LLM tab
// (Phase 5.1.2 / SWY-48). One endpoint family under /v1/stats/llm/* serves both
// scopes: `?project=KEY` → the per-project tab; omitted → the global view (all
// visible projects). Membership-aware via resolveStatsScope (shared with
// stats.ts): a `member` only sees observations whose ticket is in a visible
// project; an instance-wide actor sees everything incl. ambient (no-ticket) ops.
//
// These two tiles read the `llm_observations_daily` rollup (snappy at scale);
// the per-ticket leaderboard + HITL tiles read raw + the cost view (later).
//
// Auth: covered by the `/v1/stats/*` requireAuth guard registered in
// stats.mount — llmInsights.mount runs right after it (see routes/index.ts).

import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { inArray, sql } from "drizzle-orm";
import {
  LlmKpiStrip, LlmTokenSpend, LlmStatsWindowQuery,
  LlmCostLeaderboard, LlmCostLeaderboardQuery, LlmLatency, LlmErrorRate,
  LlmHitlStalls, LlmHitlQuery,
  type LlmTokenSpendSeries, type LlmLatencyRow,
  type LlmCostLeaderboardRow, type LlmHitlStallRow, type StatsBucket,
} from "@switchyard/shared";
import { db } from "../db.js";
import * as schema from "../../drizzle/schema.js";
import { errorResponses, okJson } from "./_helpers.js";
import { resolveStatsScope, projectInSql } from "./stats.js";
import { loadTicketSummary } from "../lib/tickets.js";
import { mapProjectRef } from "../lib/mappers.js";
import { readSettings } from "./settings.js";

const tag = "Stats";

const kpiStrip = createRoute({
  method: "get",
  path: "/v1/stats/llm/kpi",
  tags: [tag],
  summary: "LLM KPI strip — cost (WoW), p95 latency, error rate, cache hit rate",
  request: { query: LlmStatsWindowQuery },
  responses: { ...okJson(LlmKpiStrip), ...errorResponses },
});

const tokenSpend = createRoute({
  method: "get",
  path: "/v1/stats/llm/token-spend",
  tags: [tag],
  summary: "LLM token spend over time, grouped by model",
  request: { query: LlmStatsWindowQuery },
  responses: { ...okJson(LlmTokenSpend), ...errorResponses },
});

const costLeaderboard = createRoute({
  method: "get",
  path: "/v1/stats/llm/cost-leaderboard",
  tags: [tag],
  summary: "Top tickets or projects by LLM cost (with an Ambient bucket)",
  request: { query: LlmCostLeaderboardQuery },
  responses: { ...okJson(LlmCostLeaderboard), ...errorResponses },
});

const latency = createRoute({
  method: "get",
  path: "/v1/stats/llm/latency",
  tags: [tag],
  summary: "Latency p50/p95/p99 per (model, operation)",
  request: { query: LlmStatsWindowQuery },
  responses: { ...okJson(LlmLatency), ...errorResponses },
});

const errorRate = createRoute({
  method: "get",
  path: "/v1/stats/llm/error-rate",
  tags: [tag],
  summary: "Error rate over time + breakdown by error code",
  request: { query: LlmStatsWindowQuery },
  responses: { ...okJson(LlmErrorRate), ...errorResponses },
});

const hitlStalls = createRoute({
  method: "get",
  path: "/v1/stats/llm/hitl-stalls",
  tags: [tag],
  summary: "Tickets in_progress with no recent LLM activity (HITL stalls)",
  request: { query: LlmHitlQuery },
  responses: { ...okJson(LlmHitlStalls), ...errorResponses },
});

const LEADERBOARD_LIMIT = 20;
const HITL_LIMIT = 50;

// ── helpers ──────────────────────────────────────────────────────────────────

// Default KPI window is the last 7 days ("cost this week"); token-spend defaults
// wider (12 weeks) for a meaningful weekly trend.
function window(q: { since?: string; until?: string }, defaultDays: number) {
  const until = q.until ? new Date(q.until) : new Date();
  const since = q.since ? new Date(q.since) : new Date(until.getTime() - defaultDays * 86_400_000);
  return { since, until };
}

const num = (v: unknown): number => (v == null ? 0 : Number(v));

export function mount(app: OpenAPIHono) {
  // NOTE: no requireAuth here — the `/v1/stats/*` guard from stats.mount covers
  // these paths (llmInsights.mount runs immediately after stats.mount).

  app.openapi(kpiStrip, (async (c: any) => {
    const q = c.req.valid("query");
    const user = c.get("auth").user;
    const scope = await resolveStatsScope(user, q.project);
    // Member with no visible projects → nothing to show.
    if (!scope.unfiltered && scope.projectIds.length === 0) {
      return c.json(emptyKpi(), 200);
    }

    const { since, until } = window(q, 7);
    const prevStart = new Date(since.getTime() - (until.getTime() - since.getTime()));
    const sinceIso = since.toISOString();
    const untilIso = until.toISOString();
    const prevIso = prevStart.toISOString();
    const projFilter = projectInSql(scope.projectIds, scope.unfiltered, "t.project_id");

    const res = await db.execute<{
      call_count: number; cost_usd: number; prev_cost_usd: number; error_count: number;
      input_tokens: string; cache_creation_tokens: string; cache_read_tokens: string;
      p95_weighted: string;
    }>(sql`
      SELECT
        COALESCE(SUM(d.call_count) FILTER (WHERE d.bucket_date >= ${sinceIso}), 0)::int AS call_count,
        COALESCE(SUM(d.cost_usd_at_rollup) FILTER (WHERE d.bucket_date >= ${sinceIso}), 0) AS cost_usd,
        COALESCE(SUM(d.cost_usd_at_rollup) FILTER (WHERE d.bucket_date < ${sinceIso}), 0) AS prev_cost_usd,
        COALESCE(SUM(d.error_count) FILTER (WHERE d.bucket_date >= ${sinceIso}), 0)::int AS error_count,
        COALESCE(SUM(d.input_tokens) FILTER (WHERE d.bucket_date >= ${sinceIso}), 0)::bigint AS input_tokens,
        COALESCE(SUM(d.cache_creation_tokens) FILTER (WHERE d.bucket_date >= ${sinceIso}), 0)::bigint AS cache_creation_tokens,
        COALESCE(SUM(d.cache_read_tokens) FILTER (WHERE d.bucket_date >= ${sinceIso}), 0)::bigint AS cache_read_tokens,
        COALESCE(SUM(d.p95_latency_ms * d.call_count) FILTER (WHERE d.bucket_date >= ${sinceIso}), 0)::bigint AS p95_weighted
      FROM llm_observations_daily d
      LEFT JOIN tickets t ON t.id = d.ticket_id
      WHERE d.bucket_date >= ${prevIso} AND d.bucket_date < ${untilIso}
        ${projFilter}
    `);
    const row = ((res as any).rows ?? res)[0];

    const callCount = num(row?.call_count);
    const cost = num(row?.cost_usd);
    const prevCost = num(row?.prev_cost_usd);
    const errors = num(row?.error_count);
    const input = num(row?.input_tokens);
    const cacheCreate = num(row?.cache_creation_tokens);
    const cacheRead = num(row?.cache_read_tokens);
    const cacheDenom = input + cacheCreate + cacheRead;

    return c.json({
      call_count: callCount,
      cost_usd: cost,
      cost_delta_pct: prevCost > 0 ? ((cost - prevCost) / prevCost) * 100 : null,
      p95_latency_ms: callCount > 0 ? Math.round(num(row?.p95_weighted) / callCount) : 0,
      error_rate_pct: callCount > 0 ? (errors / callCount) * 100 : 0,
      cache_hit_rate_pct: cacheDenom > 0 ? (cacheRead / cacheDenom) * 100 : null,
    } satisfies LlmKpiStrip, 200);
  }) as any);

  app.openapi(tokenSpend, (async (c: any) => {
    const q = c.req.valid("query");
    const user = c.get("auth").user;
    const scope = await resolveStatsScope(user, q.project);
    const bucket: StatsBucket = q.bucket === "day" ? "day" : "week";
    if (!scope.unfiltered && scope.projectIds.length === 0) {
      return c.json({ bucket, series: [] } satisfies LlmTokenSpend, 200);
    }

    const { since, until } = window(q, 12 * 7);
    const projFilter = projectInSql(scope.projectIds, scope.unfiltered, "t.project_id");
    const truncUnit = bucket === "day" ? sql`'day'` : sql`'week'`;

    const res = await db.execute<{
      start: string; model: string; provider: string;
      input_tokens: string; output_tokens: string; cost_usd: number;
    }>(sql`
      SELECT
        date_trunc(${truncUnit}, d.bucket_date)::text AS start,
        d.model, d.provider,
        COALESCE(SUM(d.input_tokens), 0)::bigint AS input_tokens,
        COALESCE(SUM(d.output_tokens), 0)::bigint AS output_tokens,
        COALESCE(SUM(d.cost_usd_at_rollup), 0) AS cost_usd
      FROM llm_observations_daily d
      LEFT JOIN tickets t ON t.id = d.ticket_id
      WHERE d.bucket_date >= ${since.toISOString()} AND d.bucket_date < ${until.toISOString()}
        ${projFilter}
      GROUP BY 1, d.model, d.provider
      ORDER BY d.model, d.provider, 1
    `);
    const rows = ((res as any).rows ?? res) as Array<{
      start: string; model: string; provider: string;
      input_tokens: string; output_tokens: string; cost_usd: number;
    }>;

    // Group flat rows into one series per (model, provider).
    const byKey = new Map<string, LlmTokenSpendSeries>();
    for (const r of rows) {
      const key = `${r.provider} ${r.model}`;
      let series = byKey.get(key);
      if (!series) {
        series = { model: r.model, provider: r.provider, points: [] };
        byKey.set(key, series);
      }
      series.points.push({
        start: new Date(r.start).toISOString(),
        input_tokens: num(r.input_tokens),
        output_tokens: num(r.output_tokens),
        cost_usd: num(r.cost_usd),
      });
    }

    return c.json({ bucket, series: [...byKey.values()] } satisfies LlmTokenSpend, 200);
  }) as any);

  app.openapi(costLeaderboard, (async (c: any) => {
    const q = c.req.valid("query");
    const groupBy: "ticket" | "project" = q.group_by === "project" ? "project" : "ticket";
    const user = c.get("auth").user;
    const scope = await resolveStatsScope(user, q.project);
    if (!scope.unfiltered && scope.projectIds.length === 0) {
      return c.json({ group_by: groupBy, items: [] } satisfies LlmCostLeaderboard, 200);
    }
    const { since, until } = window(q, 14);
    const projFilter = projectInSql(scope.projectIds, scope.unfiltered, "t.project_id");
    // Group by the ticket itself, or by its project (ambient rows — no ticket,
    // hence no project — collapse to a single NULL bucket either way).
    const groupCol = groupBy === "project" ? sql`t.project_id` : sql`c.ticket_id`;

    const res = await db.execute<{
      group_id: string | null; cost_usd: number; call_count: number; avg_latency_ms: number;
    }>(sql`
      SELECT ${groupCol} AS group_id,
        COALESCE(SUM(c.cost_usd), 0) AS cost_usd,
        COUNT(*)::int AS call_count,
        COALESCE(AVG(c.latency_ms), 0)::int AS avg_latency_ms
      FROM llm_observations_with_cost c
      LEFT JOIN tickets t ON t.id = c.ticket_id
      WHERE c.occurred_at >= ${since.toISOString()} AND c.occurred_at < ${until.toISOString()}
        ${projFilter}
      GROUP BY ${groupCol}
      ORDER BY cost_usd DESC NULLS LAST
      LIMIT ${LEADERBOARD_LIMIT}
    `);
    const rows = ((res as any).rows ?? res) as Array<{
      group_id: string | null; cost_usd: number; call_count: number; avg_latency_ms: number;
    }>;
    const ids = rows.map((r) => r.group_id).filter((id): id is string => !!id);

    let items: LlmCostLeaderboardRow[];
    if (groupBy === "project") {
      const projects = new Map<string, ReturnType<typeof mapProjectRef>>();
      if (ids.length > 0) {
        const pr = await db.select().from(schema.projects).where(inArray(schema.projects.id, ids));
        for (const p of pr) projects.set(p.id, mapProjectRef(p));
      }
      items = rows.map((r) => ({
        ticket: null,
        project: r.group_id ? projects.get(r.group_id) ?? null : null,
        cost_usd: num(r.cost_usd),
        call_count: num(r.call_count),
        avg_latency_ms: num(r.avg_latency_ms),
      }));
    } else {
      const summaries = new Map<string, Awaited<ReturnType<typeof loadTicketSummary>>>();
      if (ids.length > 0) {
        const ticketRows = await db.select().from(schema.tickets).where(inArray(schema.tickets.id, ids));
        for (const tr of ticketRows) summaries.set(tr.id, await loadTicketSummary(tr));
      }
      items = rows.map((r) => ({
        ticket: r.group_id ? summaries.get(r.group_id) ?? null : null,
        project: null,
        cost_usd: num(r.cost_usd),
        call_count: num(r.call_count),
        avg_latency_ms: num(r.avg_latency_ms),
      }));
    }
    return c.json({ group_by: groupBy, items } satisfies LlmCostLeaderboard, 200);
  }) as any);

  app.openapi(latency, (async (c: any) => {
    const q = c.req.valid("query");
    const user = c.get("auth").user;
    const scope = await resolveStatsScope(user, q.project);
    if (!scope.unfiltered && scope.projectIds.length === 0) {
      return c.json({ rows: [] } satisfies LlmLatency, 200);
    }
    const { since, until } = window(q, 14);
    const projFilter = projectInSql(scope.projectIds, scope.unfiltered, "t.project_id");

    const res = await db.execute<{
      model: string; operation: string; p50_ms: number; p95_ms: number; p99_ms: number; call_count: number;
    }>(sql`
      SELECT d.model, d.operation,
        COALESCE(SUM(d.p50_latency_ms * d.call_count) / NULLIF(SUM(d.call_count), 0), 0)::int AS p50_ms,
        COALESCE(SUM(d.p95_latency_ms * d.call_count) / NULLIF(SUM(d.call_count), 0), 0)::int AS p95_ms,
        COALESCE(SUM(d.p99_latency_ms * d.call_count) / NULLIF(SUM(d.call_count), 0), 0)::int AS p99_ms,
        COALESCE(SUM(d.call_count), 0)::int AS call_count
      FROM llm_observations_daily d
      LEFT JOIN tickets t ON t.id = d.ticket_id
      WHERE d.bucket_date >= ${since.toISOString()} AND d.bucket_date < ${until.toISOString()}
        ${projFilter}
      GROUP BY d.model, d.operation
      ORDER BY call_count DESC
    `);
    const rows = (((res as any).rows ?? res) as LlmLatencyRow[]).map((r) => ({
      model: r.model, operation: r.operation,
      p50_ms: num(r.p50_ms), p95_ms: num(r.p95_ms), p99_ms: num(r.p99_ms), call_count: num(r.call_count),
    }));
    return c.json({ rows } satisfies LlmLatency, 200);
  }) as any);

  app.openapi(errorRate, (async (c: any) => {
    const q = c.req.valid("query");
    const user = c.get("auth").user;
    const scope = await resolveStatsScope(user, q.project);
    const bucket: StatsBucket = q.bucket === "day" ? "day" : "week";
    if (!scope.unfiltered && scope.projectIds.length === 0) {
      return c.json({ bucket, total_calls: 0, error_calls: 0, codes: [], points: [] } satisfies LlmErrorRate, 200);
    }
    const { since, until } = window(q, 14);
    const projFilter = projectInSql(scope.projectIds, scope.unfiltered, "t.project_id");
    const truncUnit = bucket === "day" ? sql`'day'` : sql`'week'`;

    // Per (bucket, error_code) from raw — daily doesn't keep the code. NULL
    // error_code = a successful call; it still counts toward the bucket total
    // (the denominator) but not toward any code's stack segment.
    const res = await db.execute<{ start: string; error_code: string | null; n: number }>(sql`
      SELECT date_trunc(${truncUnit}, o.occurred_at)::text AS start,
        o.error_code, COUNT(*)::int AS n
      FROM llm_observations o
      LEFT JOIN tickets t ON t.id = o.ticket_id
      WHERE o.occurred_at >= ${since.toISOString()} AND o.occurred_at < ${until.toISOString()}
        ${projFilter}
      GROUP BY 1, o.error_code
    `);
    const rows = ((res as any).rows ?? res) as Array<{ start: string; error_code: string | null; n: number }>;

    const byBucket = new Map<string, { call_count: number; by_code: Record<string, number> }>();
    const codeTotals = new Map<string, number>();
    let total = 0;
    let errors = 0;
    for (const r of rows) {
      const n = num(r.n);
      total += n;
      const b = byBucket.get(r.start) ?? { call_count: 0, by_code: {} };
      b.call_count += n;
      if (r.error_code != null) {
        errors += n;
        b.by_code[r.error_code] = (b.by_code[r.error_code] ?? 0) + n;
        codeTotals.set(r.error_code, (codeTotals.get(r.error_code) ?? 0) + n);
      }
      byBucket.set(r.start, b);
    }
    const points = [...byBucket.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([start, v]) => ({ start: new Date(start).toISOString(), call_count: v.call_count, by_code: v.by_code }));
    const codes = [...codeTotals.entries()].sort((a, b) => b[1] - a[1]).map(([code]) => code);

    return c.json({ bucket, total_calls: total, error_calls: errors, codes, points } satisfies LlmErrorRate, 200);
  }) as any);

  app.openapi(hitlStalls, (async (c: any) => {
    const q = c.req.valid("query");
    const user = c.get("auth").user;
    const scope = await resolveStatsScope(user, q.project);
    const settings = await readSettings();
    const inProgressHours = q.in_progress_hours ?? settings.hitl_stall_in_progress_hours;
    const silentHours = q.silent_hours ?? settings.hitl_stall_silent_hours;
    if (!scope.unfiltered && scope.projectIds.length === 0) {
      return c.json({
        threshold_in_progress_hours: inProgressHours,
        threshold_silent_hours: silentHours,
        items: [],
      } satisfies LlmHitlStalls, 200);
    }
    const projFilter = projectInSql(scope.projectIds, scope.unfiltered, "t.project_id");

    const res = await db.execute<{ id: string; hours_in_progress: number; last_activity: string | null }>(sql`
      SELECT t.id,
        EXTRACT(EPOCH FROM (now() - t.updated_at)) / 3600.0 AS hours_in_progress,
        la.last_activity::text AS last_activity
      FROM tickets t
      JOIN statuses s ON s.id = t.status_id
      LEFT JOIN LATERAL (
        SELECT MAX(o.occurred_at) AS last_activity
        FROM llm_observations o WHERE o.ticket_id = t.id
      ) la ON true
      WHERE s.category = 'in_progress'
        AND t.deleted_at IS NULL
        AND t.updated_at < now() - (${inProgressHours} * INTERVAL '1 hour')
        AND (la.last_activity IS NULL OR la.last_activity < now() - (${silentHours} * INTERVAL '1 hour'))
        ${projFilter}
      ORDER BY hours_in_progress DESC
      LIMIT ${HITL_LIMIT}
    `);
    const rows = ((res as any).rows ?? res) as Array<{ id: string; hours_in_progress: number; last_activity: string | null }>;

    const ids = rows.map((r) => r.id);
    const summaries = new Map<string, Awaited<ReturnType<typeof loadTicketSummary>>>();
    if (ids.length > 0) {
      const ticketRows = await db.select().from(schema.tickets).where(inArray(schema.tickets.id, ids));
      for (const tr of ticketRows) summaries.set(tr.id, await loadTicketSummary(tr));
    }

    const items: LlmHitlStallRow[] = [];
    for (const r of rows) {
      const ticket = summaries.get(r.id);
      if (!ticket) continue; // ticket vanished between queries — skip
      const last = r.last_activity ? new Date(r.last_activity).toISOString() : null;
      items.push({
        ticket,
        hours_in_progress: num(r.hours_in_progress),
        last_llm_activity: last,
        hours_since_activity: last
          ? (Date.now() - new Date(last).getTime()) / 3_600_000
          : null,
      });
    }
    return c.json({
      threshold_in_progress_hours: inProgressHours,
      threshold_silent_hours: silentHours,
      items,
    } satisfies LlmHitlStalls, 200);
  }) as any);
}

function emptyKpi(): LlmKpiStrip {
  return {
    call_count: 0,
    cost_usd: 0,
    cost_delta_pct: null,
    p95_latency_ms: 0,
    error_rate_pct: 0,
    cache_hit_rate_pct: null,
  };
}
