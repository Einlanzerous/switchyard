import { z } from "zod";
import { Uuid, Iso8601, TicketKey } from "./common.js";
import { ProjectRef } from "./project.js";
import { UserRef } from "./user.js";
import { TicketType, TicketSummary } from "./ticket.js";
import { Priority } from "./ticket.js";
import { StatusCategory } from "./status.js";

// ─── per-project breakdown ──────────────────────────────────────────────────
//
// Single-project deep dive. Powers the "Insights" tab on a project board and
// the per-project widgets on the dashboard.

export const TicketTotals = z.object({
  open: z.number().int().nonnegative(),    // not in 'closed' category
  closed: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
});
export type TicketTotals = z.infer<typeof TicketTotals>;

export const CategoryCounts = z.object({
  backlog: z.number().int().nonnegative(),
  planning: z.number().int().nonnegative(),
  in_progress: z.number().int().nonnegative(),
  blocked: z.number().int().nonnegative(),
  closed: z.number().int().nonnegative(),
});
export type CategoryCounts = z.infer<typeof CategoryCounts>;

export const TypeCounts = z.object({
  task: z.number().int().nonnegative(),
  bug: z.number().int().nonnegative(),
  spike: z.number().int().nonnegative(),
  epic: z.number().int().nonnegative(),
});
export type TypeCounts = z.infer<typeof TypeCounts>;

// `none` is the count of tickets with NULL priority.
export const PriorityCounts = z.object({
  low: z.number().int().nonnegative(),
  medium: z.number().int().nonnegative(),
  high: z.number().int().nonnegative(),
  critical: z.number().int().nonnegative(),
  none: z.number().int().nonnegative(),
});
export type PriorityCounts = z.infer<typeof PriorityCounts>;

export const AssigneeCount = z.object({
  user: UserRef.nullable(), // null = unassigned bucket
  count: z.number().int().nonnegative(),
});

export const ProjectStats = z.object({
  project: ProjectRef,
  totals: TicketTotals,
  by_category: CategoryCounts,
  by_priority: PriorityCounts,
  by_type: TypeCounts,
  by_assignee: z.array(AssigneeCount),       // sorted by count desc
  stale_in_progress: z.number().int().nonnegative(),
  // Currently-open tickets whose due_date has passed.
  overdue: z.number().int().nonnegative(),
  // All-time count of closed tickets where the close-out event fired after
  // the due_date — i.e. shipped late. Separate from `overdue` (which is a
  // live snapshot of work that's still open and past due).
  completed_late: z.number().int().nonnegative(),
  most_recent_activity: Iso8601.nullable(),
});
export type ProjectStats = z.infer<typeof ProjectStats>;

// ─── bulk projects feed ─────────────────────────────────────────────────────
//
// List-page friendly. Drops the heavy assignee/priority/type breakdowns;
// keep this small so the Projects directory can fan in and back out fast.

export const ProjectStatsRow = z.object({
  project: ProjectRef,
  totals: TicketTotals,
  by_category: CategoryCounts,
});
export type ProjectStatsRow = z.infer<typeof ProjectStatsRow>;

export const ProjectStatsList = z.object({
  items: z.array(ProjectStatsRow),
});
export type ProjectStatsList = z.infer<typeof ProjectStatsList>;

// ─── throughput (closed-per-period) ─────────────────────────────────────────

export const StatsBucket = z.enum(["day", "week"]);
export type StatsBucket = z.infer<typeof StatsBucket>;

// Actor-type split (SWY-138): `human_count` counts closures whose actor is a
// `type = human` user; `agent_count` is everything else — agent users AND
// system/null actors, which are machines for attribution purposes. Invariant:
// agent_count + human_count === count.
export const ThroughputPoint = z.object({
  start: Iso8601,            // bucket-start timestamp (date_trunc)
  count: z.number().int().nonnegative(),
  agent_count: z.number().int().nonnegative(),
  human_count: z.number().int().nonnegative(),
});

export const ThroughputStats = z.object({
  bucket: StatsBucket,
  points: z.array(ThroughputPoint),
  total: z.number().int().nonnegative(),
  // Window-wide split totals — the "agent share" aggregate. Clients derive
  // the percentage (guard the zero-total window).
  agent_total: z.number().int().nonnegative(),
  human_total: z.number().int().nonnegative(),
});
export type ThroughputStats = z.infer<typeof ThroughputStats>;

// ─── closed-by-actor leaderboard ("who did the work") ───────────────────────
//
// Windowed, cross-project (scope-filtered) count of ticket.closed events per
// closing ACTOR — the user who performed the close, not the assignee. Powers
// the v4 insights leaderboard + force-multiplier. Closures with no surviving
// actor row (deleted user / system) are omitted from the per-user list but
// still appear in the throughput totals above.

export const ClosedByActorRow = z.object({
  user: UserRef,
  closed: z.number().int().positive(),
});
export type ClosedByActorRow = z.infer<typeof ClosedByActorRow>;

export const ClosedByActorStats = z.object({
  items: z.array(ClosedByActorRow),
});
export type ClosedByActorStats = z.infer<typeof ClosedByActorStats>;

// ─── cycle time (in_progress duration distribution) ─────────────────────────
//
// One sample per ticket closed in the window. `duration_ms` is the total time
// the ticket spent in any in_progress status (multiple back-and-forth visits
// are summed). Blocked time is excluded by design — it's a separate metric.

export const CycleTimeSample = z.object({
  ticket_id: z.string().uuid(),
  ticket_key: TicketKey,
  type: TicketType,
  duration_ms: z.number().int().nonnegative(),
  closed_at: Iso8601,
});
export type CycleTimeSample = z.infer<typeof CycleTimeSample>;

export const CycleTimeByType = z.object({
  task: z.object({ median_ms: z.number().int().nonnegative(), count: z.number().int().nonnegative() }),
  bug: z.object({ median_ms: z.number().int().nonnegative(), count: z.number().int().nonnegative() }),
  spike: z.object({ median_ms: z.number().int().nonnegative(), count: z.number().int().nonnegative() }),
  epic: z.object({ median_ms: z.number().int().nonnegative(), count: z.number().int().nonnegative() }),
});

export const CycleTimeStats = z.object({
  count: z.number().int().nonnegative(),
  median_ms: z.number().int().nonnegative(),
  p50_ms: z.number().int().nonnegative(),
  p90_ms: z.number().int().nonnegative(),
  p95_ms: z.number().int().nonnegative(),
  by_type: CycleTimeByType,
  // Bounded — we cap at 5000 events; if exceeded, the request 400s. Truncation
  // doesn't happen silently. This field is reserved for future opt-in detail
  // views that include the per-ticket samples.
  samples: z.array(CycleTimeSample).optional(),
});
export type CycleTimeStats = z.infer<typeof CycleTimeStats>;

// ─── stale work rollup (homepage widget) ────────────────────────────────────
//
// One row per project that has at least one stale-in-progress ticket. When
// stale_count == 1 we include the single ticket as `sample_ticket` so the UI
// can show a ticket row directly; when stale_count >= 2 the UI rolls up to
// "<Project> · N stale" and `sample_ticket` is null.

export const StaleRollupRow = z.object({
  project: ProjectRef,
  stale_count: z.number().int().nonnegative(),
  sample_ticket: TicketSummary.nullable(),
});

export const StaleRollup = z.object({
  items: z.array(StaleRollupRow),
});
export type StaleRollup = z.infer<typeof StaleRollup>;

// MentionList / MentionItem schemas existed for the 3.1 live-scan and were
// dropped in 3.4 along with /v1/users/me/mentions. Use the persistent
// notifications schema (`shared/src/schemas/notification.ts`) instead.

// ─── cumulative flow ────────────────────────────────────────────────────────
//
// One row per bucket-end timestamp; values are the count of tickets in each
// status category as of that timestamp. Reconstructed by replaying
// ticket.created / ticket.status_changed / ticket.deleted events; the
// resulting series powers cumulative-flow diagrams and burndown charts.

export const CumulativeFlowPoint = z.object({
  end: Iso8601,
  by_category: CategoryCounts,
});

export const CumulativeFlowStats = z.object({
  bucket: StatsBucket,
  points: z.array(CumulativeFlowPoint),
});
export type CumulativeFlowStats = z.infer<typeof CumulativeFlowStats>;

// ─── shared query params for windowed stats ─────────────────────────────────
//
// `project` is a comma-list of project keys, mirroring the tickets-list query
// shape. `since`/`until` are required-ish — server defaults `since` to 12
// weeks ago and `until` to now if omitted.

export const StatsWindowQuery = z.object({
  project: z.string().optional(),    // CSV of project keys, e.g. "FLOW,DEMO"
  since: Iso8601.optional(),
  until: Iso8601.optional(),
  bucket: StatsBucket.optional(),    // throughput-only; ignored elsewhere
});
export type StatsWindowQuery = z.infer<typeof StatsWindowQuery>;

// Re-export StatusCategory for clients consuming this module without needing
// to import status.js separately.
export { StatusCategory };
