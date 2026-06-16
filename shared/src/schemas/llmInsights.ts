import { z } from "zod";
import { Iso8601, Uuid } from "./common.js";
import { StatsBucket } from "./stats.js";
import { TicketSummary } from "./ticket.js";
import { ProjectRef } from "./project.js";

// Read-side schemas for the LLM Insights tab (Phase 5.1.2 / SWY-48). These power
// the global /insights/llm view and the per-project /projects/:key/insights/llm
// tab — the same endpoints serve both: `project` (a CSV of project keys) scopes
// them. Omitted = all visible projects (global); one key = the per-project tab.
//
// Global KPI + time-series read the `llm_observations_daily` rollup; per-ticket
// and HITL tiles (later) read raw + the cost view.

export const LlmStatsWindowQuery = z.object({
  project: z.string().optional(), // CSV of project keys; omit for all-visible
  since: Iso8601.optional(),
  until: Iso8601.optional(),
  bucket: StatsBucket.optional(), // time-series only; defaults to week
});
export type LlmStatsWindowQuery = z.infer<typeof LlmStatsWindowQuery>;

// ── KPI strip ───────────────────────────────────────────────────────────────

export const LlmKpiStrip = z.object({
  call_count: z.number().int().nonnegative(),
  cost_usd: z.number().nonnegative(),
  // % change vs the equal-length window immediately before `since`. null when
  // the prior window had zero cost (no baseline) — the UI shows no delta badge.
  cost_delta_pct: z.number().nullable(),
  // Call-weighted mean of the daily-rollup p95 latency across the window. The
  // rollup stores per-day percentiles, so this approximates a true window-p95;
  // good enough for a headline tile, exact per-day values live in the rollup.
  p95_latency_ms: z.number().int().nonnegative(),
  error_rate_pct: z.number().min(0).max(100),
  // cache_read / (cache_read + cache_creation + input). null when no tokens in
  // the window (nothing to divide).
  cache_hit_rate_pct: z.number().min(0).max(100).nullable(),
});
export type LlmKpiStrip = z.infer<typeof LlmKpiStrip>;

// ── token spend over time (stacked area, grouped by model) ───────────────────

export const LlmTokenSpendPoint = z.object({
  start: Iso8601, // bucket-start timestamp
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  cost_usd: z.number().nonnegative(),
});
export type LlmTokenSpendPoint = z.infer<typeof LlmTokenSpendPoint>;

export const LlmTokenSpendSeries = z.object({
  model: z.string(),
  provider: z.string(),
  points: z.array(LlmTokenSpendPoint),
});
export type LlmTokenSpendSeries = z.infer<typeof LlmTokenSpendSeries>;

export const LlmTokenSpend = z.object({
  bucket: StatsBucket,
  series: z.array(LlmTokenSpendSeries), // one entry per (model, provider)
});
export type LlmTokenSpend = z.infer<typeof LlmTokenSpend>;

// ── cost leaderboard (raw + cost view), grouped by ticket or project ─────────

export const LlmCostGroupBy = z.enum(["ticket", "project"]);
export type LlmCostGroupBy = z.infer<typeof LlmCostGroupBy>;

export const LlmCostLeaderboardQuery = z.object({
  project: z.string().optional(),
  since: Iso8601.optional(),
  until: Iso8601.optional(),
  group_by: LlmCostGroupBy.optional(), // default "ticket"
});
export type LlmCostLeaderboardQuery = z.infer<typeof LlmCostLeaderboardQuery>;

// Exactly one of ticket/project is set per the requested group_by; both null =
// the "Ambient" bucket (observations with no ticket / no project).
export const LlmCostLeaderboardRow = z.object({
  ticket: TicketSummary.nullable(),
  project: ProjectRef.nullable(),
  cost_usd: z.number().nonnegative(),
  call_count: z.number().int().nonnegative(),
  avg_latency_ms: z.number().int().nonnegative(),
});
export type LlmCostLeaderboardRow = z.infer<typeof LlmCostLeaderboardRow>;

export const LlmCostLeaderboard = z.object({
  group_by: LlmCostGroupBy,
  items: z.array(LlmCostLeaderboardRow), // sorted by cost_usd desc
});
export type LlmCostLeaderboard = z.infer<typeof LlmCostLeaderboard>;

// ── latency percentiles per (model, operation) ───────────────────────────────
// Call-weighted across the daily rollup's per-day percentiles.

export const LlmLatencyRow = z.object({
  model: z.string(),
  operation: z.string(),
  p50_ms: z.number().int().nonnegative(),
  p95_ms: z.number().int().nonnegative(),
  p99_ms: z.number().int().nonnegative(),
  call_count: z.number().int().nonnegative(),
});
export type LlmLatencyRow = z.infer<typeof LlmLatencyRow>;

export const LlmLatency = z.object({
  rows: z.array(LlmLatencyRow), // sorted by call_count desc
});
export type LlmLatency = z.infer<typeof LlmLatency>;

// ── error rate (per-bucket, broken down by error code — for a stacked bar) ────
// Each point carries the bucket's total call count + a per-code error tally; the
// UI stacks each code's share of calls (%) so one bar = the bucket's error rate
// split by code. Computed from raw (the daily rollup doesn't keep the code).

export const LlmErrorRatePoint = z.object({
  start: Iso8601,
  call_count: z.number().int().nonnegative(),
  by_code: z.record(z.string(), z.number().int().nonnegative()), // code → count
});
export type LlmErrorRatePoint = z.infer<typeof LlmErrorRatePoint>;

export const LlmErrorRate = z.object({
  bucket: StatsBucket,
  total_calls: z.number().int().nonnegative(),
  error_calls: z.number().int().nonnegative(),
  codes: z.array(z.string()), // distinct error codes in window, most-frequent first
  points: z.array(LlmErrorRatePoint),
});
export type LlmErrorRate = z.infer<typeof LlmErrorRate>;

// ── HITL stall detector (raw + tickets) ──────────────────────────────────────
// Tickets in_progress longer than N hours with no LLM activity in the last M
// hours. N/M default from system_settings (hitl_stall_*), overridable per call.

export const LlmHitlStallRow = z.object({
  ticket: TicketSummary,
  hours_in_progress: z.number().nonnegative(),
  last_llm_activity: Iso8601.nullable(), // null = never observed
  hours_since_activity: z.number().nonnegative().nullable(),
});
export type LlmHitlStallRow = z.infer<typeof LlmHitlStallRow>;

export const LlmHitlStalls = z.object({
  threshold_in_progress_hours: z.number().nonnegative(),
  threshold_silent_hours: z.number().nonnegative(),
  items: z.array(LlmHitlStallRow), // sorted by hours_in_progress desc
});
export type LlmHitlStalls = z.infer<typeof LlmHitlStalls>;

// Query for the HITL endpoint: window scope + optional threshold overrides.
export const LlmHitlQuery = z.object({
  project: z.string().optional(),
  in_progress_hours: z.coerce.number().nonnegative().optional(),
  silent_hours: z.coerce.number().nonnegative().optional(),
});
export type LlmHitlQuery = z.infer<typeof LlmHitlQuery>;

// ── warn-list (unknown dimension values pending admin review) ─────────────────
// Admin → Observability. Promote/reject is UI-resolution-only in 5.1.2: it
// marks the row resolved and clears it from the pending list; it does NOT
// (yet) make future writes of a rejected value 422.

export const LlmPendingDimension = z.enum(["service", "operation", "model", "provider"]);
export type LlmPendingDimension = z.infer<typeof LlmPendingDimension>;

export const LlmPendingResolution = z.enum(["promoted", "rejected"]);
export type LlmPendingResolution = z.infer<typeof LlmPendingResolution>;

export const LlmPendingValue = z.object({
  id: Uuid,
  dimension: LlmPendingDimension,
  value: z.string(),
  observation_count: z.number().int().nonnegative(),
  first_seen_at: Iso8601,
  last_seen_at: Iso8601,
  resolved_at: Iso8601.nullable(),
  resolution: LlmPendingResolution.nullable(),
});
export type LlmPendingValue = z.infer<typeof LlmPendingValue>;

export const LlmPendingValueList = z.object({
  items: z.array(LlmPendingValue), // sorted by last_seen_at desc
});
export type LlmPendingValueList = z.infer<typeof LlmPendingValueList>;

// Query for listing pending values. `include_resolved` is a string enum (not a
// coerced boolean) so a literal "false" doesn't coerce to true.
export const LlmPendingValueQuery = z.object({
  dimension: LlmPendingDimension.optional(),
  include_resolved: z.enum(["true", "false"]).optional(),
});
export type LlmPendingValueQuery = z.infer<typeof LlmPendingValueQuery>;
