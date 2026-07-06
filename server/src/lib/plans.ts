// Plan-as-PR domain logic (Phase 7 / SWY-109).
//
// Pure helpers (state-machine outcome + render-time diff) plus the loaders that
// assemble the nested API shapes. Transaction orchestration + event emission
// live in the route handler (mirrors comments.ts), so writeEvent stays close to
// the actor/ticket context it needs.

import { and, asc, desc, eq, inArray, type SQL } from "drizzle-orm";
import * as schema from "../../drizzle/schema.js";
import { db } from "../db.js";
import { mapUserRef } from "./mappers.js";
import { badRequest, notFound } from "../errors.js";
import { visibleProjectFilter, writableProjectFilter } from "./authz.js";
import { buildPage, cursorOrderBy, cursorWhere, decodeCursor } from "./pagination.js";
import { loadTicketSummary } from "./tickets.js";
import type {
  EventType,
  Plan,
  PlanCriterion,
  PlanDiff,
  PlanListItem,
  PlanRevision,
  PlanRevisionStatus,
  PlanRevisionSummary,
  PlanReview,
  PlanStatus,
  ReviewVerdict,
} from "@switchyard/shared";

type AuthUserScope = Parameters<typeof visibleProjectFilter>[0];

type Tx = typeof db;
type UserRow = typeof schema.users.$inferSelect;
type PlanRow = typeof schema.plans.$inferSelect;
type RevisionRow = typeof schema.planRevisions.$inferSelect;
type CriterionRow = typeof schema.planCriteria.$inferSelect;
type ReviewRow = typeof schema.planReviews.$inferSelect;

// ─── state machine ────────────────────────────────────────────────────────────

// The single mapping from a review's overall verdict to the resulting revision
// status, plan status, and emitted event. `rejected` deliberately lands the plan
// back in `changes_requested` (a rework state) while emitting the DISTINCT
// `plan.rejected` event, so 7.2 policy/rules can route "wrong approach" to a
// harder ticket state than the nit-fix `plan.changes_requested` loop.
export function reviewOutcome(verdict: ReviewVerdict): {
  revisionStatus: PlanRevisionStatus;
  planStatus: PlanStatus;
  eventType: EventType;
} {
  switch (verdict) {
    case "approved":
      return { revisionStatus: "approved", planStatus: "approved", eventType: "plan.approved" };
    case "changes_requested":
      return {
        revisionStatus: "changes_requested",
        planStatus: "changes_requested",
        eventType: "plan.changes_requested",
      };
    case "rejected":
      return { revisionStatus: "rejected", planStatus: "changes_requested", eventType: "plan.rejected" };
  }
}

// ─── plan-anchored comments (7.1) ───────────────────────────────────────────────

// Validate a plan-anchored comment before it is inserted (the create handler in
// comments.ts calls this inside its transaction). The DB CHECK already enforces
// anchor⇒revision; this adds the two cross-row invariants it can't express:
//   - the revision must belong to a plan rooted on THIS ticket (no cross-ticket
//     anchoring), and
//   - a `criterion:<id>` anchor must name a criterion that exists in that
//     revision (a `section:` / `plan` anchor is free-form and needs no lookup).
// Throws badRequest/notFound on violation. `anchor` is the raw `plan_anchor`.
export async function assertPlanAnchorForTicket(
  tx: Tx,
  ticketId: string,
  planRevisionId: string,
  anchor: string | null,
): Promise<void> {
  const [rev] = await tx.select({ id: schema.planRevisions.id, planId: schema.planRevisions.plan_id })
    .from(schema.planRevisions)
    .where(eq(schema.planRevisions.id, planRevisionId))
    .limit(1);
  if (!rev) throw notFound("plan revision");

  const [plan] = await tx.select({ ticketId: schema.plans.ticket_id })
    .from(schema.plans)
    .where(eq(schema.plans.id, rev.planId))
    .limit(1);
  if (!plan || plan.ticketId !== ticketId) {
    throw badRequest("plan revision does not belong to this ticket");
  }

  if (anchor && anchor.startsWith("criterion:")) {
    const criterionId = anchor.slice("criterion:".length);
    const [crit] = await tx.select({ id: schema.planCriteria.id })
      .from(schema.planCriteria)
      .where(and(eq(schema.planCriteria.id, criterionId), eq(schema.planCriteria.revision_id, planRevisionId)))
      .limit(1);
    if (!crit) throw badRequest("plan_anchor criterion not found in this revision");
  }
}

// ─── diff ──────────────────────────────────────────────────────────────────────

type DiffOp = { type: "context" | "added" | "removed"; value: string };

// Minimal LCS line/item diff — no external dependency. Classic dynamic-program
// LCS table walked back into a context/added/removed op stream. Inputs are line
// arrays (narrative) or criterion-text arrays; both are small (≤100s of items).
function lcsDiff(a: string[], b: string[]): DiffOp[] {
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: "context", value: b[j]! });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      ops.push({ type: "removed", value: a[i]! });
      i++;
    } else {
      ops.push({ type: "added", value: b[j]! });
      j++;
    }
  }
  while (i < n) ops.push({ type: "removed", value: a[i++]! });
  while (j < m) ops.push({ type: "added", value: b[j++]! });
  return ops;
}

// Render-time diff of one revision against its predecessor. `prev` is null when
// there is no predecessor (revision 1) — callers omit the diff field entirely in
// that case, but we still return a well-formed object for symmetry.
export function computePlanDiff(
  prev: { rev_number: number; narrative_md: string; criteria: string[] } | null,
  curr: { narrative_md: string; criteria: string[] },
): PlanDiff {
  if (!prev) {
    return {
      from_rev_number: null,
      narrative: curr.narrative_md.split("\n").map((value) => ({ type: "added" as const, text: value })),
      criteria: curr.criteria.map((text, position) => ({ type: "added" as const, position, text })),
    };
  }

  const narrative = lcsDiff(prev.narrative_md.split("\n"), curr.narrative_md.split("\n")).map((op) => ({
    type: op.type,
    text: op.value,
  }));

  // Walk the criteria LCS, assigning each row a position on its own side so the
  // UI can render added/removed/unchanged in order.
  let prevPos = 0;
  let currPos = 0;
  const criteria = lcsDiff(prev.criteria, curr.criteria).map((op) => {
    if (op.type === "removed") return { type: "removed" as const, position: prevPos++, text: op.value };
    if (op.type === "added") return { type: "added" as const, position: currPos++, text: op.value };
    const position = currPos;
    prevPos++;
    currPos++;
    return { type: "unchanged" as const, position, text: op.value };
  });

  return { from_rev_number: prev.rev_number, narrative, criteria };
}

// ─── mappers ───────────────────────────────────────────────────────────────────

export function mapPlanCriterion(row: CriterionRow): PlanCriterion {
  return {
    id: row.id,
    position: row.position,
    text: row.text,
    verdict: row.verdict,
    reviewer_note: row.reviewer_note ?? null,
  };
}

export function mapPlanReview(row: ReviewRow, reviewer: UserRow): PlanReview {
  return {
    id: row.id,
    reviewer: mapUserRef(reviewer),
    verdict: row.verdict,
    note: row.note ?? null,
    created_at: row.created_at,
  };
}

export function mapPlanRevisionSummary(row: RevisionRow, submitter: UserRow): PlanRevisionSummary {
  return {
    id: row.id,
    rev_number: row.rev_number,
    status: row.status,
    submitted_by: mapUserRef(submitter),
    submitted_at: row.submitted_at,
  };
}

// ─── loaders ───────────────────────────────────────────────────────────────────

// Assemble the full PlanRevision API shape: criteria (ordered) + reviews +
// (optionally) the diff against the predecessor revision. One query per child
// table + a batched user lookup, mirroring the comments list loader.
export async function loadRevisionApi(
  rev: RevisionRow,
  opts: { withDiff?: boolean } = {},
  tx: Tx = db,
): Promise<PlanRevision> {
  const [criteriaRows, reviewRows] = await Promise.all([
    tx.select().from(schema.planCriteria)
      .where(eq(schema.planCriteria.revision_id, rev.id))
      .orderBy(asc(schema.planCriteria.position)),
    tx.select().from(schema.planReviews)
      .where(eq(schema.planReviews.revision_id, rev.id))
      .orderBy(asc(schema.planReviews.created_at)),
  ]);

  const userIds = [...new Set([rev.submitted_by, ...reviewRows.map((r) => r.reviewer_id)])];
  const users = await tx.select().from(schema.users).where(inArray(schema.users.id, userIds));
  const userById = new Map(users.map((u) => [u.id, u]));
  const submitter = userById.get(rev.submitted_by);
  if (!submitter) throw new Error("plan revision submitter missing");

  const revision: PlanRevision = {
    id: rev.id,
    rev_number: rev.rev_number,
    narrative_md: rev.narrative_md,
    status: rev.status,
    submitted_by: mapUserRef(submitter),
    submitted_at: rev.submitted_at,
    criteria: criteriaRows.map(mapPlanCriterion),
    reviews: reviewRows.map((r) => mapPlanReview(r, userById.get(r.reviewer_id)!)),
  };

  if (opts.withDiff && rev.rev_number > 1) {
    const [prevRev] = await tx.select().from(schema.planRevisions)
      .where(and(eq(schema.planRevisions.plan_id, rev.plan_id), eq(schema.planRevisions.rev_number, rev.rev_number - 1)))
      .limit(1);
    if (prevRev) {
      const prevCriteria = await tx.select().from(schema.planCriteria)
        .where(eq(schema.planCriteria.revision_id, prevRev.id))
        .orderBy(asc(schema.planCriteria.position));
      revision.diff = computePlanDiff(
        { rev_number: prevRev.rev_number, narrative_md: prevRev.narrative_md, criteria: prevCriteria.map((c) => c.text) },
        { narrative_md: rev.narrative_md, criteria: criteriaRows.map((c) => c.text) },
      );
    }
  }

  return revision;
}

// ─── collection loader (7.1) ─────────────────────────────────────────────────

// The cross-ticket plans list behind `GET /v1/plans`. Joins plans → tickets to
// scope by project + visibility, batches the current-revision rows / criteria
// counts / submitters, and embeds a full ticket summary per row (bounded by
// `limit`, so no unbounded N+1 — both callers, the homepage widget and the board
// badge index, request a small page). Newest-first by the plan's updated_at.
export async function listPlansApi(
  user: AuthUserScope,
  opts: {
    statuses?: PlanStatus[];
    projectKey?: string;
    awaitingMyReview?: boolean;
    limit: number;
    cursor?: string | null;
  },
): Promise<{ items: PlanListItem[]; page: { next_cursor: string | null; has_more: boolean } }> {
  const conds: SQL[] = [];

  // Status filter. `awaiting_my_review` forces in_review (the only reviewable
  // state) and overrides any explicit status list.
  if (opts.awaitingMyReview) {
    conds.push(eq(schema.plans.status, "in_review"));
  } else if (opts.statuses && opts.statuses.length > 0) {
    conds.push(inArray(schema.plans.status, opts.statuses));
  }

  // Optional single-project scope (by key). An unknown or invisible project
  // yields an empty page rather than a 404 — this is a filtered collection, so
  // we look the key up directly (getProjectByKey throws notFound, which would
  // surface as a 404 instead of an empty list).
  if (opts.projectKey) {
    const [project] = await db
      .select({ id: schema.projects.id })
      .from(schema.projects)
      .where(eq(schema.projects.key, opts.projectKey))
      .limit(1);
    if (!project) return { items: [], page: { next_cursor: null, has_more: false } };
    conds.push(eq(schema.tickets.project_id, project.id));
  }

  // Visibility scoping: the review queue restricts to projects the user can
  // WRITE (only there can they act on a plan); the general list, to readable
  // projects. A `null` filter means an instance-wide actor (no restriction).
  const scopeFilter = opts.awaitingMyReview
    ? await writableProjectFilter(user, schema.tickets.project_id)
    : await visibleProjectFilter(user, schema.tickets.project_id);
  if (scopeFilter) conds.push(scopeFilter);

  if (opts.cursor) {
    const cur = decodeCursor(opts.cursor);
    if (cur) conds.push(cursorWhere(schema.plans.updated_at, schema.plans.id, cur));
  }

  const rows = await db
    .select({ plan: schema.plans, ticket: schema.tickets })
    .from(schema.plans)
    .innerJoin(schema.tickets, eq(schema.tickets.id, schema.plans.ticket_id))
    .where(conds.length > 0 ? and(...conds) : undefined)
    .orderBy(...cursorOrderBy(schema.plans.updated_at, schema.plans.id))
    .limit(opts.limit + 1);

  const currentRevIds = rows
    .map((r) => r.plan.current_revision_id)
    .filter((x): x is string => x !== null);

  const revRows = currentRevIds.length > 0
    ? await db.select().from(schema.planRevisions).where(inArray(schema.planRevisions.id, currentRevIds))
    : [];
  const revById = new Map(revRows.map((r) => [r.id, r]));

  const critRows = currentRevIds.length > 0
    ? await db
        .select({ revision_id: schema.planCriteria.revision_id, verdict: schema.planCriteria.verdict })
        .from(schema.planCriteria)
        .where(inArray(schema.planCriteria.revision_id, currentRevIds))
    : [];
  const countsByRev = new Map<string, { total: number; pending: number }>();
  for (const cr of critRows) {
    const c = countsByRev.get(cr.revision_id) ?? { total: 0, pending: 0 };
    c.total += 1;
    if (cr.verdict === "pending") c.pending += 1;
    countsByRev.set(cr.revision_id, c);
  }

  const submitterIds = [...new Set(revRows.map((r) => r.submitted_by))];
  const submitters = submitterIds.length > 0
    ? await db.select().from(schema.users).where(inArray(schema.users.id, submitterIds))
    : [];
  const userById = new Map(submitters.map((u) => [u.id, u]));

  const items: PlanListItem[] = [];
  for (const r of rows) {
    const rev = r.plan.current_revision_id ? revById.get(r.plan.current_revision_id) : undefined;
    if (!rev) continue; // defensive: a plan always has a current revision post-7.0
    const submitter = userById.get(rev.submitted_by);
    if (!submitter) continue;
    const counts = countsByRev.get(rev.id) ?? { total: 0, pending: 0 };
    items.push({
      id: r.plan.id,
      ticket: await loadTicketSummary(r.ticket),
      status: r.plan.status,
      revision_count: r.plan.revision_count,
      current_revision: {
        id: rev.id,
        rev_number: rev.rev_number,
        status: rev.status,
        submitted_by: mapUserRef(submitter),
        submitted_at: rev.submitted_at,
        criteria_total: counts.total,
        criteria_pending: counts.pending,
      },
      created_at: r.plan.created_at,
      updated_at: r.plan.updated_at,
    });
  }

  return buildPage(items, opts.limit);
}

// The full Plan shape for a ticket (with its current revision embedded), or null
// when the ticket has no plan yet.
export async function loadPlanForTicket(ticketId: string, tx: Tx = db): Promise<Plan | null> {
  const [plan] = await tx.select().from(schema.plans)
    .where(eq(schema.plans.ticket_id, ticketId))
    .limit(1);
  if (!plan) return null;

  const current = await loadCurrentRevisionRow(plan, tx);
  if (!current) throw new Error(`plan ${plan.id} has no current revision`);

  return mapPlan(plan, await loadRevisionApi(current, { withDiff: true }, tx));
}

export function mapPlan(plan: PlanRow, currentRevision: PlanRevision): Plan {
  return {
    id: plan.id,
    ticket_id: plan.ticket_id,
    status: plan.status,
    revision_count: plan.revision_count,
    current_revision: currentRevision,
    created_at: plan.created_at,
    updated_at: plan.updated_at,
  };
}

// Resolve a plan's current revision row. Prefers the `current_revision_id`
// pointer; falls back to the highest rev_number (defensive — the pointer is kept
// consistent by the write path, but the fallback keeps reads robust).
export async function loadCurrentRevisionRow(plan: PlanRow, tx: Tx = db): Promise<RevisionRow | undefined> {
  if (plan.current_revision_id) {
    const [row] = await tx.select().from(schema.planRevisions)
      .where(eq(schema.planRevisions.id, plan.current_revision_id))
      .limit(1);
    if (row) return row;
  }
  const [latest] = await tx.select().from(schema.planRevisions)
    .where(eq(schema.planRevisions.plan_id, plan.id))
    .orderBy(desc(schema.planRevisions.rev_number))
    .limit(1);
  return latest;
}
