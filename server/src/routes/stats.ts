// Read-only stats endpoints powering Phase 3 dashboards.
//
// All four endpoints are bounded:
//   - per-project / bulk stats: no event scan, just COUNT FILTER on tickets
//   - throughput: SQL GROUP BY date_trunc on events, no per-row JS work
//   - cycle-time: pulls events into memory; capped at 5000 per request,
//     400 if exceeded so we never silently truncate
//
// Auth: read for everyone with a valid token (read-only data, no PII beyond
// what /v1/tickets already exposes). No special scope.

import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { and, eq, gte, inArray, isNull, lte, sql, type SQL } from "drizzle-orm";
import {
  ProjectStats, ProjectStatsList, ThroughputStats, CycleTimeStats,
  CumulativeFlowStats, StaleRollup, ClosedByActorStats,
  ActivityPulseStats, ACTIVITY_PULSE_DAYS,
  EpicsInFlightStats, EPIC_STALL_AFTER_DAYS,
  ProjectKey, StatsBucket, StatsWindowQuery,
  type StatusCategory, type TicketType, type Priority,
} from "@switchyard/shared";
import { db } from "../db.js";
import * as schema from "../../drizzle/schema.js";
import { requireAuth } from "../auth.js";
import { errorResponses, okJson, z } from "./_helpers.js";
import { badRequest } from "../errors.js";
import { mapProjectRef, mapUserRef, mapTicketSummary } from "../lib/mappers.js";
import { getProjectByKey } from "../lib/lookups.js";
import {
  assertProjectReadable, hasInstanceWideAccess, visibleProjectFilter, visibleProjectIds,
} from "../lib/authz.js";
import { readSettings } from "./settings.js";
import { alias } from "drizzle-orm/pg-core";
import {
  buildCycleTimeSamples, summarizeCycleTime, resolveWindow,
  buildTimelines, computeCumulativeFlow, bucketEnds,
  type StatusChangeRow, type ClosedTicketInfo,
} from "../lib/stats.js";

const tag = "Stats";

// Hard cap on per-request event scan. 5000 is well above any realistic
// dashboard load; if a real install hits this we should switch to a
// pre-aggregated rollup table rather than raise the cap.
const EVENT_SCAN_CAP = 5_000;

// Cumulative-flow inherently needs more data than throughput/cycle-time —
// we have to read every status change in project history (not just within
// the window) to know each ticket's current category. Cap higher so users
// with real history still get a chart; document escape hatch separately.
const CFD_EVENT_SCAN_CAP = 50_000;

// ─── route definitions ─────────────────────────────────────────────────────

const projectStats = createRoute({
  method: "get",
  path: "/v1/projects/{key}/stats",
  tags: [tag],
  summary: "Per-project ticket counts and breakdowns",
  request: { params: z.object({ key: ProjectKey }) },
  responses: { ...okJson(ProjectStats), ...errorResponses },
});

const projectsStatsList = createRoute({
  method: "get",
  path: "/v1/stats/projects",
  tags: [tag],
  summary: "Bulk per-project totals (list-page friendly)",
  responses: { ...okJson(ProjectStatsList), ...errorResponses },
});

const throughput = createRoute({
  method: "get",
  path: "/v1/stats/throughput",
  tags: [tag],
  summary: "Closed tickets per period",
  request: { query: StatsWindowQuery },
  responses: { ...okJson(ThroughputStats), ...errorResponses },
});

const cycleTime = createRoute({
  method: "get",
  path: "/v1/stats/cycle-time",
  tags: [tag],
  summary: "Cycle-time distribution (in_progress duration only)",
  request: { query: StatsWindowQuery },
  responses: { ...okJson(CycleTimeStats), ...errorResponses },
});

const cumulativeFlow = createRoute({
  method: "get",
  path: "/v1/stats/cumulative-flow",
  tags: [tag],
  summary: "Per-bucket category counts for cumulative-flow / burndown",
  request: { query: StatsWindowQuery },
  responses: { ...okJson(CumulativeFlowStats), ...errorResponses },
});

const staleRollup = createRoute({
  method: "get",
  path: "/v1/stats/stale",
  tags: [tag],
  summary: "Per-project rollup of stale in-progress tickets",
  responses: { ...okJson(StaleRollup), ...errorResponses },
});

const activityPulse = createRoute({
  method: "get",
  path: "/v1/stats/activity-pulse",
  tags: [tag],
  summary: "Per-project activity pulse (last activity, 14d daily series, recent actors)",
  description:
    "One row per visible non-deleted project: all-time most-recent event " +
    "timestamp, a fixed 14-day UTC-day-aligned daily event-count series " +
    "(oldest → newest, last bucket = today, partial), and up to 3 distinct " +
    "recent actors (most-recent first) from the same window. Constant query " +
    "count regardless of project count.",
  responses: { ...okJson(ActivityPulseStats), ...errorResponses },
});

const epicsInFlight = createRoute({
  method: "get",
  path: "/v1/stats/epics",
  tags: [tag],
  summary: "Open epics with child-completion progress, driver, and stall flag",
  description:
    "One row per open (non-closed) epic in scope. `progress_pct` = closed " +
    "children / total children × 100 (0 when childless). `driver` = actor " +
    "of the most recent event on the epic or any child. `stalled` = the " +
    "epic is in_progress AND no agent-actor event touched the family within " +
    "`stall_after_days` (the 'no LLM activity' signal); backlog/planning " +
    "epics are never stalled. Constant query count regardless of epic count.",
  responses: { ...okJson(EpicsInFlightStats), ...errorResponses },
});

const closedByActor = createRoute({
  method: "get",
  path: "/v1/stats/closed-by-actor",
  tags: [tag],
  summary: "Windowed 'who did the work' leaderboard (closures per closing actor)",
  description:
    "Counts ticket.closed events per closing ACTOR (the user who performed " +
    "the close — not the assignee) in the window, scope-filtered like every " +
    "stats endpoint. Closures whose actor row no longer exists (deleted " +
    "user / system) are omitted here but still counted by /v1/stats/" +
    "throughput totals. Sorted by count desc.",
  request: { query: StatsWindowQuery },
  responses: { ...okJson(ClosedByActorStats), ...errorResponses },
});

// ─── small helpers ─────────────────────────────────────────────────────────

const CATEGORIES: StatusCategory[] = ["backlog", "planning", "in_progress", "blocked", "closed"];
const PRIORITIES: Priority[] = ["low", "medium", "high", "critical"];
const TYPES: TicketType[] = ["task", "bug", "spike", "epic"];

// Resolve `?project=KEY,KEY2` → row-array of project rows. If unset, returns
// every non-deleted project. Keys with no match are ignored (don't 404 the
// whole dashboard because one project key is stale).
async function resolveProjects(csv: string | undefined) {
  if (!csv || csv.trim().length === 0) {
    return await db
      .select()
      .from(schema.projects)
      .where(isNull(schema.projects.deleted_at));
  }
  const keys = csv.split(",").map((s) => s.trim()).filter(Boolean);
  if (keys.length === 0) return [];
  return await db
    .select()
    .from(schema.projects)
    .where(and(inArray(schema.projects.key, keys), isNull(schema.projects.deleted_at)));
}

// 6.1.4: resolve the project scope for an aggregate request, membership-aware.
// Returns the concrete project ids to aggregate over plus `unfiltered` — true
// ONLY for an instance-wide actor with no explicit `?project=` (aggregate over
// everything, no IN filter). A `member` is NEVER unfiltered: with no `?project=`
// they get their full visible set; with `?project=` they get the intersection;
// a member with no visible projects gets an empty set. This replaces the old
// `projectIds.length === 0` overload that conflated "all projects" with "named
// but none matched" — for a zero-project member that branch leaked everything.
export async function resolveStatsScope(
  user: Parameters<typeof hasInstanceWideAccess>[0] & { id: string },
  csv: string | undefined,
): Promise<{ projectIds: string[]; unfiltered: boolean }> {
  const rows = await resolveProjects(csv);
  const hasCsv = !!csv && csv.trim().length > 0;
  if (hasInstanceWideAccess(user)) {
    return { projectIds: rows.map((r) => r.id), unfiltered: !hasCsv };
  }
  const visible = await visibleProjectIds(user);
  return {
    projectIds: rows.filter((r) => visible.has(r.id)).map((r) => r.id),
    unfiltered: false,
  };
}

// Inline `AND <col> IN (...)` fragment for the raw-SQL aggregates, or empty SQL
// when unfiltered. Only ever called with a non-empty id list (callers early-
// return on the `!unfiltered && empty` case first). ids are DB-issued UUIDs;
// inline-quoting matches the existing throughput pattern.
export function projectInSql(projectIds: string[], unfiltered: boolean, col: string): SQL {
  if (unfiltered) return sql``;
  return sql.raw(`AND ${col} IN (${projectIds.map((id) => `'${id}'`).join(",")})`) as unknown as SQL;
}

// One-shot SELECT with COUNT(*) FILTER (...) for every breakdown bucket.
// `extraStaleClause` is a SQL fragment that produces an INTERVAL — it lives
// inside the FILTER so we only count "stale in_progress" tickets.
type AggRow = {
  open: number; closed: number; total: number;
  cat_backlog: number; cat_planning: number; cat_in_progress: number; cat_blocked: number; cat_closed: number;
  prio_low: number; prio_medium: number; prio_high: number; prio_critical: number; prio_none: number;
  type_task: number; type_bug: number; type_spike: number; type_epic: number;
  stale: number;
  overdue: number;
  completed_late: number;
  recent: string | null;
};

async function fetchProjectAgg(projectId: string, staleDays: number): Promise<AggRow> {
  const rows = await db.execute<AggRow>(sql`
    SELECT
      COUNT(*) FILTER (WHERE s.category <> 'closed')::int AS open,
      COUNT(*) FILTER (WHERE s.category = 'closed')::int AS closed,
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE s.category = 'backlog')::int     AS cat_backlog,
      COUNT(*) FILTER (WHERE s.category = 'planning')::int    AS cat_planning,
      COUNT(*) FILTER (WHERE s.category = 'in_progress')::int AS cat_in_progress,
      COUNT(*) FILTER (WHERE s.category = 'blocked')::int     AS cat_blocked,
      COUNT(*) FILTER (WHERE s.category = 'closed')::int      AS cat_closed,
      COUNT(*) FILTER (WHERE t.priority = 'low')::int       AS prio_low,
      COUNT(*) FILTER (WHERE t.priority = 'medium')::int    AS prio_medium,
      COUNT(*) FILTER (WHERE t.priority = 'high')::int      AS prio_high,
      COUNT(*) FILTER (WHERE t.priority = 'critical')::int  AS prio_critical,
      COUNT(*) FILTER (WHERE t.priority IS NULL)::int       AS prio_none,
      COUNT(*) FILTER (WHERE t.type = 'task')::int  AS type_task,
      COUNT(*) FILTER (WHERE t.type = 'bug')::int   AS type_bug,
      COUNT(*) FILTER (WHERE t.type = 'spike')::int AS type_spike,
      COUNT(*) FILTER (WHERE t.type = 'epic')::int  AS type_epic,
      COUNT(*) FILTER (
        WHERE s.category = 'in_progress'
          AND t.updated_at < (NOW() - (${staleDays} * INTERVAL '1 day'))
      )::int AS stale,
      COUNT(*) FILTER (
        WHERE s.category <> 'closed'
          AND t.due_date IS NOT NULL
          AND t.due_date < NOW()
      )::int AS overdue,
      -- Closed tickets whose latest close-out event fired after the due_date.
      -- EXISTS keeps this cheap; events_ticket_idx covers (ticket_id, created_at).
      -- A reopen+reclose cycle where ANY close was late still counts as late,
      -- which matches "did we ship past the deadline" intent.
      COUNT(*) FILTER (
        WHERE s.category = 'closed'
          AND t.due_date IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM events e
            WHERE e.ticket_id = t.id
              AND e.event_type = 'ticket.closed'
              AND e.created_at > t.due_date
          )
      )::int AS completed_late,
      MAX(t.updated_at)::text AS recent
    FROM tickets t
    JOIN statuses s ON s.id = t.status_id
    WHERE t.project_id = ${projectId}
      AND t.deleted_at IS NULL
  `);
  // `db.execute` returns a postgres result with `.rows`; older drizzle
  // versions returned a plain array. Normalize.
  const row = (rows as any).rows ? (rows as any).rows[0] : (rows as any)[0];
  if (!row) {
    return {
      open: 0, closed: 0, total: 0,
      cat_backlog: 0, cat_planning: 0, cat_in_progress: 0, cat_blocked: 0, cat_closed: 0,
      prio_low: 0, prio_medium: 0, prio_high: 0, prio_critical: 0, prio_none: 0,
      type_task: 0, type_bug: 0, type_spike: 0, type_epic: 0,
      stale: 0, overdue: 0, completed_late: 0, recent: null,
    };
  }
  return row as AggRow;
}

export function mount(app: OpenAPIHono) {
  app.use("/v1/projects/*", requireAuth);
  app.use("/v1/stats/*", requireAuth);

  // ─── per-project deep dive ───────────────────────────────────────────────

  app.openapi(projectStats, (async (c: any) => {
    const { key } = c.req.valid("param");
    const project = await getProjectByKey(key, { includeArchived: true });
    // 6.1.4: a non-member asking for a project's stats gets 404, not its counts.
    await assertProjectReadable(c.get("auth").user, project.id, "project");
    const settings = await readSettings();

    const agg = await fetchProjectAgg(project.id, settings.stale_in_progress_days);

    // Assignee buckets — a separate small query so the main aggregate stays
    // a fixed-size row. Joined to users so we can return a UserRef.
    const assigneeRows = await db.execute<{
      user_id: string | null;
      name: string | null;
      icon: string | null;
      type: "agent" | "human" | null;
      count: number;
    }>(sql`
      SELECT
        t.assignee_id  AS user_id,
        u.name         AS name,
        u.icon         AS icon,
        u.type         AS type,
        COUNT(*)::int  AS count
      FROM tickets t
      LEFT JOIN users u ON u.id = t.assignee_id
      WHERE t.project_id = ${project.id}
        AND t.deleted_at IS NULL
      GROUP BY t.assignee_id, u.name, u.icon, u.type
      ORDER BY COUNT(*) DESC
    `);
    const aRows = (assigneeRows as any).rows ?? assigneeRows;
    const by_assignee = (aRows as Array<typeof aRows[number]>).map((r: any) => ({
      user: r.user_id
        ? { id: r.user_id, name: r.name!, icon: r.icon, type: r.type! }
        : null,
      count: r.count,
    }));

    return c.json(
      {
        project: mapProjectRef(project),
        totals: { open: agg.open, closed: agg.closed, total: agg.total },
        by_category: {
          backlog: agg.cat_backlog,
          planning: agg.cat_planning,
          in_progress: agg.cat_in_progress,
          blocked: agg.cat_blocked,
          closed: agg.cat_closed,
        },
        by_priority: {
          low: agg.prio_low,
          medium: agg.prio_medium,
          high: agg.prio_high,
          critical: agg.prio_critical,
          none: agg.prio_none,
        },
        by_type: {
          task: agg.type_task,
          bug: agg.type_bug,
          spike: agg.type_spike,
          epic: agg.type_epic,
        },
        by_assignee,
        stale_in_progress: agg.stale,
        overdue: agg.overdue,
        completed_late: agg.completed_late,
        most_recent_activity: agg.recent,
      },
      200
    );
  }) as any);

  // ─── bulk feed for the Projects directory ────────────────────────────────

  app.openapi(projectsStatsList, (async (c: any) => {
    // 6.1.4: members see only their projects' rows; a zero-project member gets
    // an empty directory, never the full instance.
    const user = c.get("auth").user;
    const visible = hasInstanceWideAccess(user) ? null : await visibleProjectIds(user);
    if (visible && visible.size === 0) return c.json({ items: [] }, 200);
    const projFilter = visible ? projectInSql([...visible], false, "p.id") : sql``;

    // One query: all visible non-deleted projects + their counts, joined through
    // tickets+statuses. A project with zero tickets still returns a row
    // (totals = 0) so the directory shows it.
    const rows = await db.execute<{
      id: string; key: string; name: string; color: string | null;
      open: number; closed: number; total: number;
      cat_backlog: number; cat_planning: number; cat_in_progress: number;
      cat_blocked: number; cat_closed: number;
    }>(sql`
      SELECT
        p.id, p.key, p.name, p.color,
        COALESCE(COUNT(t.id) FILTER (WHERE s.category <> 'closed'), 0)::int AS open,
        COALESCE(COUNT(t.id) FILTER (WHERE s.category = 'closed'),   0)::int AS closed,
        COALESCE(COUNT(t.id), 0)::int AS total,
        COALESCE(COUNT(t.id) FILTER (WHERE s.category = 'backlog'),     0)::int AS cat_backlog,
        COALESCE(COUNT(t.id) FILTER (WHERE s.category = 'planning'),    0)::int AS cat_planning,
        COALESCE(COUNT(t.id) FILTER (WHERE s.category = 'in_progress'), 0)::int AS cat_in_progress,
        COALESCE(COUNT(t.id) FILTER (WHERE s.category = 'blocked'),     0)::int AS cat_blocked,
        COALESCE(COUNT(t.id) FILTER (WHERE s.category = 'closed'),      0)::int AS cat_closed
      FROM projects p
      LEFT JOIN tickets t ON t.project_id = p.id AND t.deleted_at IS NULL
      LEFT JOIN statuses s ON s.id = t.status_id
      WHERE p.deleted_at IS NULL
        ${projFilter}
      GROUP BY p.id, p.key, p.name, p.color
      ORDER BY p.key
    `);
    const projRows = ((rows as any).rows ?? rows) as Array<any>;

    return c.json(
      {
        items: projRows.map((r) => ({
          project: { id: r.id, key: r.key, name: r.name, color: r.color },
          totals: { open: r.open, closed: r.closed, total: r.total },
          by_category: {
            backlog: r.cat_backlog,
            planning: r.cat_planning,
            in_progress: r.cat_in_progress,
            blocked: r.cat_blocked,
            closed: r.cat_closed,
          },
        })),
      },
      200
    );
  }) as any);

  // ─── throughput (closed-per-period) ──────────────────────────────────────

  app.openapi(throughput, (async (c: any) => {
    const q = c.req.valid("query");
    const bucket: StatsBucket = q.bucket ?? "week";
    const { since, until } = resolveWindow(q);
    const { projectIds, unfiltered } = await resolveStatsScope(c.get("auth").user, q.project);
    // Member with no visible projects (or named keys none of which they can see)
    // → empty series, never the all-projects fallback.
    if (!unfiltered && projectIds.length === 0) {
      return c.json({ bucket, points: [], total: 0, agent_total: 0, human_total: 0 }, 200);
    }

    const trunc = bucket === "day" ? sql`'day'` : sql`'week'`;

    // Actor-type split (SWY-138): human = closures by a `type = human` user;
    // agent = everything else (agent users AND system/null actors — machines
    // for attribution). LEFT JOIN so a deleted actor still counts (as agent).
    const rows = await db.execute<{ start: string; count: number; human_count: number }>(sql`
      SELECT
        date_trunc(${trunc}, e.created_at)::text AS start,
        COUNT(*)::int AS count,
        COUNT(*) FILTER (WHERE u.type = 'human')::int AS human_count
      FROM events e
      LEFT JOIN users u ON u.id = e.actor_id
      WHERE e.event_type = 'ticket.closed'
        AND e.created_at >= ${since.toISOString()}
        AND e.created_at <= ${until.toISOString()}
        ${projectInSql(projectIds, unfiltered, "e.project_id")}
      GROUP BY 1
      ORDER BY 1 ASC
    `);

    const tRows = ((rows as any).rows ?? rows) as Array<{ start: string; count: number; human_count: number }>;
    const points = tRows.map((r) => ({
      // Postgres returns date_trunc as a timestamp string; force ISO with Z.
      start: new Date(r.start).toISOString(),
      count: r.count,
      agent_count: r.count - r.human_count,
      human_count: r.human_count,
    }));
    const total = points.reduce((a, b) => a + b.count, 0);
    const human_total = points.reduce((a, b) => a + b.human_count, 0);
    return c.json(
      { bucket, points, total, agent_total: total - human_total, human_total },
      200
    );
  }) as any);

  // ─── epics in flight ──────────────────────────────────────────────────────

  app.openapi(epicsInFlight, (async (c: any) => {
    const user = c.get("auth").user;
    const visible = hasInstanceWideAccess(user) ? null : await visibleProjectIds(user);
    if (visible && visible.size === 0) {
      return c.json({ stall_after_days: EPIC_STALL_AFTER_DAYS, items: [] }, 200);
    }
    const epicFilter = visible ? projectInSql([...visible], false, "t.project_id") : sql``;

    // Query 1: open epics + status + project ref.
    const epicRows = await db.execute<{
      id: string; key_num: number; title: string;
      p_id: string; p_key: string; p_name: string; p_color: string | null; p_repo: string | null;
      s_id: string; s_category: string; s_display: string;
    }>(sql`
      SELECT
        t.id, t.number AS key_num, t.title,
        p.id AS p_id, p.key AS p_key, p.name AS p_name, p.color AS p_color, p.repo_url AS p_repo,
        s.id AS s_id, s.category AS s_category, s.display_name AS s_display
      FROM tickets t
      JOIN projects p ON p.id = t.project_id AND p.deleted_at IS NULL
      JOIN statuses s ON s.id = t.status_id
      WHERE t.type = 'epic'
        AND t.deleted_at IS NULL
        AND s.category <> 'closed'
        ${epicFilter}
      ORDER BY p.key, t.number
    `);
    const eRows = ((epicRows as any).rows ?? epicRows) as Array<{
      id: string; key_num: number; title: string;
      p_id: string; p_key: string; p_name: string; p_color: string | null; p_repo: string | null;
      s_id: string; s_category: string; s_display: string;
    }>;
    if (eRows.length === 0) {
      return c.json({ stall_after_days: EPIC_STALL_AFTER_DAYS, items: [] }, 200);
    }
    const epicIds = eRows.map((r) => r.id);

    // Query 2: child-completion aggregate over parent_id (one GROUP BY, no
    // per-epic fetch).
    const childRows = await db.execute<{ parent_id: string; total: number; done: number }>(sql`
      SELECT
        t.parent_id,
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE s.category = 'closed')::int AS done
      FROM tickets t
      JOIN statuses s ON s.id = t.status_id
      WHERE t.parent_id IN ${sql.raw(`(${epicIds.map((id) => `'${id}'`).join(",")})`)}
        AND t.deleted_at IS NULL
      GROUP BY t.parent_id
    `);
    const cRows = ((childRows as any).rows ?? childRows) as Array<{ parent_id: string; total: number; done: number }>;
    const progress = new Map(cRows.map((r) => [r.parent_id, r]));

    // Queries 3+4: latest event per epic family (epic itself or a child),
    // once for any actor (driver + last activity) and once for agent actors
    // only (stall detection). `epic_id` folds children onto their parent.
    const idList = sql.raw(`(${epicIds.map((id) => `'${id}'`).join(",")})`);
    const latestAny = await db.execute<{
      epic_id: string; at: string;
      u_id: string | null; u_name: string | null; u_icon: string | null; u_type: string | null;
    }>(sql`
      SELECT DISTINCT ON (fam.epic_id)
        fam.epic_id, e.created_at::text AS at,
        u.id AS u_id, u.name AS u_name, u.icon AS u_icon, u.type AS u_type
      FROM events e
      JOIN tickets t ON t.id = e.ticket_id
      CROSS JOIN LATERAL (
        SELECT CASE WHEN t.type = 'epic' THEN t.id ELSE t.parent_id END AS epic_id
      ) fam
      LEFT JOIN users u ON u.id = e.actor_id
      WHERE fam.epic_id IN ${idList}
      ORDER BY fam.epic_id, e.created_at DESC
    `);
    const latestAgent = await db.execute<{ epic_id: string; at: string }>(sql`
      SELECT DISTINCT ON (fam.epic_id) fam.epic_id, e.created_at::text AS at
      FROM events e
      JOIN tickets t ON t.id = e.ticket_id
      CROSS JOIN LATERAL (
        SELECT CASE WHEN t.type = 'epic' THEN t.id ELSE t.parent_id END AS epic_id
      ) fam
      JOIN users u ON u.id = e.actor_id AND u.type = 'agent'
      WHERE fam.epic_id IN ${idList}
      ORDER BY fam.epic_id, e.created_at DESC
    `);
    const anyRows = ((latestAny as any).rows ?? latestAny) as Array<{
      epic_id: string; at: string;
      u_id: string | null; u_name: string | null; u_icon: string | null; u_type: string | null;
    }>;
    const agentRows = ((latestAgent as any).rows ?? latestAgent) as Array<{ epic_id: string; at: string }>;
    const lastAny = new Map(anyRows.map((r) => [r.epic_id, r]));
    const lastAgentAt = new Map(agentRows.map((r) => [r.epic_id, new Date(r.at).getTime()]));

    const stallCutoff = Date.now() - EPIC_STALL_AFTER_DAYS * 86_400_000;

    return c.json(
      {
        stall_after_days: EPIC_STALL_AFTER_DAYS,
        items: eRows.map((r) => {
          const prog = progress.get(r.id);
          const total = prog?.total ?? 0;
          const done = prog?.done ?? 0;
          const last = lastAny.get(r.id);
          const agentAt = lastAgentAt.get(r.id);
          const stalled =
            r.s_category === "in_progress" && (agentAt === undefined || agentAt < stallCutoff);
          return {
            id: r.id,
            key: `${r.p_key}-${r.key_num}`,
            title: r.title,
            project: { id: r.p_id, key: r.p_key, name: r.p_name, color: r.p_color, repo_url: r.p_repo },
            status: { id: r.s_id, category: r.s_category, display_name: r.s_display },
            progress_pct: total === 0 ? 0 : Math.round((done / total) * 100),
            children_total: total,
            children_closed: done,
            driver: last?.u_id
              ? { id: last.u_id, name: last.u_name!, icon: last.u_icon, type: last.u_type! }
              : null,
            last_activity_at: last ? new Date(last.at).toISOString() : null,
            stalled,
          };
        }),
      },
      200
    );
  }) as any);

  // ─── per-project activity pulse ───────────────────────────────────────────

  app.openapi(activityPulse, (async (c: any) => {
    const user = c.get("auth").user;
    const visible = hasInstanceWideAccess(user) ? null : await visibleProjectIds(user);
    if (visible && visible.size === 0) return c.json({ days: ACTIVITY_PULSE_DAYS, items: [] }, 200);
    const projFilter = visible ? projectInSql([...visible], false, "p.id") : sql``;
    const evFilter = visible ? projectInSql([...visible], false, "e.project_id") : sql``;

    // UTC-day-aligned buckets: [today-13d .. today], oldest → newest.
    const now = new Date();
    const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    const sinceIso = new Date(todayUtc - (ACTIVITY_PULSE_DAYS - 1) * 86_400_000).toISOString();

    // Three fixed queries regardless of project count (no per-project N+1):
    // projects + all-time last activity, windowed per-day counts, windowed
    // distinct actors.
    const projectRows = await db.execute<{
      id: string; key: string; name: string; color: string | null;
      repo_url: string | null; last: string | null;
    }>(sql`
      SELECT p.id, p.key, p.name, p.color, p.repo_url, MAX(e.created_at)::text AS last
      FROM projects p
      LEFT JOIN events e ON e.project_id = p.id
      WHERE p.deleted_at IS NULL
        ${projFilter}
      GROUP BY p.id, p.key, p.name, p.color, p.repo_url
      ORDER BY p.key
    `);

    const dayRows = await db.execute<{ project_id: string; day: string; count: number }>(sql`
      SELECT e.project_id, date_trunc('day', e.created_at)::text AS day, COUNT(*)::int AS count
      FROM events e
      WHERE e.created_at >= ${sinceIso}
        ${evFilter}
      GROUP BY 1, 2
    `);

    const actorRows = await db.execute<{
      project_id: string; id: string; name: string; icon: string | null; type: string; last: string;
    }>(sql`
      SELECT e.project_id, u.id, u.name, u.icon, u.type, MAX(e.created_at)::text AS last
      FROM events e
      JOIN users u ON u.id = e.actor_id
      WHERE e.created_at >= ${sinceIso}
        ${evFilter}
      GROUP BY e.project_id, u.id, u.name, u.icon, u.type
      ORDER BY last DESC
    `);

    const pRows = ((projectRows as any).rows ?? projectRows) as Array<{
      id: string; key: string; name: string; color: string | null;
      repo_url: string | null; last: string | null;
    }>;
    const dRows = ((dayRows as any).rows ?? dayRows) as Array<{ project_id: string; day: string; count: number }>;
    const aRows = ((actorRows as any).rows ?? actorRows) as Array<{
      project_id: string; id: string; name: string; icon: string | null; type: string; last: string;
    }>;

    const seriesByProject = new Map<string, number[]>();
    for (const r of dRows) {
      let series = seriesByProject.get(r.project_id);
      if (!series) {
        series = new Array<number>(ACTIVITY_PULSE_DAYS).fill(0);
        seriesByProject.set(r.project_id, series);
      }
      // date_trunc comes back as "YYYY-MM-DD 00:00:00+00" text — new Date()
      // parses it (same convention as the throughput handler above).
      const idx = Math.floor((new Date(r.day).getTime() - (todayUtc - (ACTIVITY_PULSE_DAYS - 1) * 86_400_000)) / 86_400_000);
      if (idx >= 0 && idx < ACTIVITY_PULSE_DAYS) series[idx] = r.count;
    }

    const actorsByProject = new Map<string, Array<{ id: string; name: string; icon: string | null; type: string }>>();
    for (const r of aRows) {
      const arr = actorsByProject.get(r.project_id) ?? [];
      if (arr.length < 3) {
        arr.push({ id: r.id, name: r.name, icon: r.icon, type: r.type });
        actorsByProject.set(r.project_id, arr);
      }
    }

    return c.json(
      {
        days: ACTIVITY_PULSE_DAYS,
        items: pRows.map((p) => ({
          project: { id: p.id, key: p.key, name: p.name, color: p.color, repo_url: p.repo_url },
          last_activity_at: p.last ? new Date(p.last).toISOString() : null,
          activity_series: seriesByProject.get(p.id) ?? new Array<number>(ACTIVITY_PULSE_DAYS).fill(0),
          recent_actors: actorsByProject.get(p.id) ?? [],
        })),
      },
      200
    );
  }) as any);

  // ─── closed-by-actor leaderboard ("who did the work") ────────────────────

  app.openapi(closedByActor, (async (c: any) => {
    const q = c.req.valid("query");
    const { since, until } = resolveWindow(q);
    const { projectIds, unfiltered } = await resolveStatsScope(c.get("auth").user, q.project);
    if (!unfiltered && projectIds.length === 0) {
      return c.json({ items: [] }, 200);
    }

    const rows = await db.execute<{
      id: string; name: string; icon: string | null; type: string; closed: number;
    }>(sql`
      SELECT u.id, u.name, u.icon, u.type, COUNT(*)::int AS closed
      FROM events e
      JOIN users u ON u.id = e.actor_id
      WHERE e.event_type = 'ticket.closed'
        AND e.created_at >= ${since.toISOString()}
        AND e.created_at <= ${until.toISOString()}
        ${projectInSql(projectIds, unfiltered, "e.project_id")}
      GROUP BY u.id, u.name, u.icon, u.type
      ORDER BY closed DESC, u.name ASC
    `);

    const lRows = ((rows as any).rows ?? rows) as Array<{
      id: string; name: string; icon: string | null; type: string; closed: number;
    }>;
    return c.json(
      {
        items: lRows.map((r) => ({
          user: { id: r.id, name: r.name, icon: r.icon, type: r.type },
          closed: r.closed,
        })),
      },
      200
    );
  }) as any);

  // ─── cycle-time distribution ─────────────────────────────────────────────

  app.openapi(cycleTime, (async (c: any) => {
    const q = c.req.valid("query");
    const { since, until } = resolveWindow(q);
    const { projectIds, unfiltered } = await resolveStatsScope(c.get("auth").user, q.project);
    if (!unfiltered && projectIds.length === 0) {
      return c.json(emptyCycleTime(), 200);
    }

    // Step 1: identify tickets that were closed in [since, until] within scope.
    // We look for ticket.closed events; payload.ticket carries the snapshot
    // at the time of the event so we can pluck key/type without rejoining.
    const closedEvents = await db
      .select({
        ticket_id: schema.events.ticket_id,
        created_at: schema.events.created_at,
        payload: schema.events.payload,
      })
      .from(schema.events)
      .where(
        and(
          eq(schema.events.event_type, "ticket.closed"),
          gte(schema.events.created_at, since.toISOString()),
          lte(schema.events.created_at, until.toISOString()),
          ...(!unfiltered
            ? [inArray(schema.events.project_id, projectIds)]
            : [])
        )
      );

    if (closedEvents.length > EVENT_SCAN_CAP) {
      throw badRequest(
        `cycle-time scan exceeds the ${EVENT_SCAN_CAP}-event cap (got ${closedEvents.length} closures). Narrow the window.`
      );
    }

    const closed = new Map<string, ClosedTicketInfo>();
    for (const e of closedEvents) {
      if (!e.ticket_id) continue;
      const p = (e.payload ?? {}) as { ticket?: { key?: string; type?: TicketType } | null };
      const tk = p.ticket?.key;
      const ty = p.ticket?.type;
      if (!tk || !ty) continue; // event was emitted before we started snapshotting; skip
      if (ty === "subtask") continue; // subtasks are excluded from cycle-time (SWY-118)
      // First-write wins so a ticket re-closed twice in the window doesn't
      // double-count. (Re-open then re-close is rare but possible.)
      if (closed.has(e.ticket_id)) continue;
      closed.set(e.ticket_id, {
        ticket_id: e.ticket_id,
        ticket_key: tk,
        type: ty,
        closed_at: e.created_at,
      });
    }

    if (closed.size === 0) return c.json(emptyCycleTime(), 200);

    // Step 2: pull ALL status_changed events for those tickets. The "since"
    // bound doesn't apply here — we need the full timeline to compute total
    // in_progress duration before the close. The cap covers both phases.
    const ticketIds = Array.from(closed.keys());
    const statusEvents = await db
      .select({
        ticket_id: schema.events.ticket_id,
        created_at: schema.events.created_at,
        payload: schema.events.payload,
      })
      .from(schema.events)
      .where(
        and(
          eq(schema.events.event_type, "ticket.status_changed"),
          inArray(schema.events.ticket_id, ticketIds)
        )
      );

    if (closedEvents.length + statusEvents.length > EVENT_SCAN_CAP) {
      throw badRequest(
        `cycle-time scan exceeds the ${EVENT_SCAN_CAP}-event cap (got ${closedEvents.length + statusEvents.length} events). Narrow the window.`
      );
    }

    const eventsByTicket = new Map<string, StatusChangeRow[]>();
    for (const e of statusEvents) {
      if (!e.ticket_id) continue;
      const p = (e.payload ?? {}) as {
        changes?: { status?: { from?: { category?: string } | null; to?: { category?: string } | null } | null };
      };
      const from = p.changes?.status?.from?.category ?? null;
      const to = p.changes?.status?.to?.category ?? null;
      if (!to) continue;
      const list = eventsByTicket.get(e.ticket_id) ?? [];
      list.push({
        ticket_id: e.ticket_id,
        created_at: e.created_at,
        from_category: from,
        to_category: to,
      });
      eventsByTicket.set(e.ticket_id, list);
    }

    const samples = buildCycleTimeSamples(closed, eventsByTicket);
    return c.json(summarizeCycleTime(samples), 200);
  }) as any);

  // ─── cumulative flow / burndown ──────────────────────────────────────────
  //
  // We pull every ticket.created / ticket.status_changed / ticket.deleted
  // event ever recorded for projects in scope, not just the window — the
  // category at the START of the window depends on transitions that
  // happened before it. Bucket boundaries land at the end-of-day or
  // end-of-week (UTC) so they line up with the throughput endpoint's
  // date_trunc.

  app.openapi(cumulativeFlow, (async (c: any) => {
    const q = c.req.valid("query");
    const bucket: StatsBucket = q.bucket ?? "week";
    const { since, until } = resolveWindow(q);
    const { projectIds, unfiltered } = await resolveStatsScope(c.get("auth").user, q.project);
    if (!unfiltered && projectIds.length === 0) {
      return c.json({ bucket, points: [] }, 200);
    }

    const events = await db
      .select({
        ticket_id: schema.events.ticket_id,
        event_type: schema.events.event_type,
        created_at: schema.events.created_at,
        payload: schema.events.payload,
      })
      .from(schema.events)
      .where(
        and(
          inArray(schema.events.event_type, [
            "ticket.created",
            "ticket.status_changed",
            "ticket.deleted",
          ]),
          lte(schema.events.created_at, until.toISOString()),
          ...(!unfiltered
            ? [inArray(schema.events.project_id, projectIds)]
            : [])
        )
      );

    if (events.length > CFD_EVENT_SCAN_CAP) {
      throw badRequest(
        `cumulative-flow scan exceeds the ${CFD_EVENT_SCAN_CAP}-event cap (got ${events.length}). Narrow the project scope or shrink the window.`
      );
    }

    const timelines = buildTimelines(events);
    const ends = bucketEnds(since, until, bucket);
    const points = computeCumulativeFlow(timelines, ends);
    return c.json({ bucket, points }, 200);
  }) as any);

  // ─── stale rollup ────────────────────────────────────────────────────────
  //
  // Returns one row per project that has at least one stale-in-progress
  // ticket. When stale_count == 1, sample_ticket carries the actual ticket
  // so the homepage widget can render a row directly; ≥ 2 → null and the
  // widget rolls up to "<Project> · N stale".
  //
  // Two passes:
  //   1. SELECT all stale tickets (joined with project + status) — this is
  //      the materialized set. Bound by the natural cap of in_progress
  //      tickets in active projects.
  //   2. Group by project; for projects with count == 1, build a TicketSummary
  //      with assignee/reporter/labels.

  app.openapi(staleRollup, (async (c: any) => {
    const settings = await readSettings();
    const cutoffIso = new Date(
      Date.now() - settings.stale_in_progress_days * 24 * 60 * 60 * 1000
    ).toISOString();

    const assigneeAlias = alias(schema.users, "stale_assignee");
    const reporterAlias = alias(schema.users, "stale_reporter");

    // 6.1.4: members roll up only their own projects' stale tickets.
    const scope = await visibleProjectFilter(c.get("auth").user, schema.projects.id);

    const rows = await db
      .select({
        t: schema.tickets,
        project: schema.projects,
        status: schema.statuses,
        assignee: assigneeAlias,
        reporter: reporterAlias,
      })
      .from(schema.tickets)
      .innerJoin(schema.projects, eq(schema.tickets.project_id, schema.projects.id))
      .innerJoin(schema.statuses, eq(schema.tickets.status_id, schema.statuses.id))
      .leftJoin(assigneeAlias, eq(schema.tickets.assignee_id, assigneeAlias.id))
      .innerJoin(reporterAlias, eq(schema.tickets.reporter_id, reporterAlias.id))
      .where(
        and(
          isNull(schema.tickets.deleted_at),
          isNull(schema.projects.deleted_at),
          isNull(schema.projects.archived_at),
          eq(schema.statuses.category, "in_progress"),
          lte(schema.tickets.updated_at, cutoffIso),
          ...(scope ? [scope] : [])
        )
      );

    // Group by project, keeping all rows so we can pick a sample later.
    const byProject = new Map<string, typeof rows>();
    for (const r of rows) {
      const list = byProject.get(r.project.id) ?? [];
      list.push(r);
      byProject.set(r.project.id, list);
    }

    // Labels only fetched for projects with exactly one stale ticket — they
    // need a full TicketSummary. For multi-stale projects we just need the
    // count.
    const singleSampleIds = [...byProject.values()]
      .filter((rs) => rs.length === 1)
      .map((rs) => rs[0]!.t.id);

    const labelsByTicket = new Map<string, typeof schema.labels.$inferSelect[]>();
    if (singleSampleIds.length > 0) {
      const labelRows = await db
        .select({ ticket_id: schema.ticketLabels.ticket_id, label: schema.labels })
        .from(schema.ticketLabels)
        .innerJoin(schema.labels, eq(schema.ticketLabels.label_id, schema.labels.id))
        .where(inArray(schema.ticketLabels.ticket_id, singleSampleIds));
      for (const lr of labelRows) {
        const list = labelsByTicket.get(lr.ticket_id) ?? [];
        list.push(lr.label);
        labelsByTicket.set(lr.ticket_id, list);
      }
    }

    const items = [...byProject.entries()].map(([projectId, projRows]) => {
      const proj = projRows[0]!.project;
      void projectId;
      const sample = projRows.length === 1
        ? mapTicketSummary(projRows[0]!.t, {
            project: proj,
            status: projRows[0]!.status,
            assignee: projRows[0]!.assignee,
            reporter: projRows[0]!.reporter,
            labels: labelsByTicket.get(projRows[0]!.t.id) ?? [],
            number: projRows[0]!.t.number,
            // Stats sample summaries are render-only context; skip the
            // refs fan-out to keep this endpoint cheap.
            externalRefs: [],
          })
        : null;
      return {
        project: mapProjectRef(proj),
        stale_count: projRows.length,
        sample_ticket: sample,
      };
    });
    // Sort by stale_count desc so the worst offenders surface first.
    items.sort((a, b) => b.stale_count - a.stale_count);
    return c.json({ items }, 200);
  }) as any);

  // unused vars referenced for type-checking only
  void CATEGORIES; void PRIORITIES; void TYPES; void mapUserRef;
}

function emptyCycleTime(): CycleTimeStats {
  return {
    count: 0, median_ms: 0, p50_ms: 0, p90_ms: 0, p95_ms: 0,
    by_type: {
      task: { median_ms: 0, count: 0 },
      bug: { median_ms: 0, count: 0 },
      spike: { median_ms: 0, count: 0 },
      epic: { median_ms: 0, count: 0 },
    },
  };
}
