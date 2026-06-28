// Plan-as-PR domain logic (Phase 7 / SWY-109).
//
// Pure helpers (state-machine outcome + render-time diff) plus the loaders that
// assemble the nested API shapes. Transaction orchestration + event emission
// live in the route handler (mirrors comments.ts), so writeEvent stays close to
// the actor/ticket context it needs.

import { and, asc, desc, eq, inArray } from "drizzle-orm";
import * as schema from "../../drizzle/schema.js";
import { db } from "../db.js";
import { mapUserRef } from "./mappers.js";
import type {
  EventType,
  Plan,
  PlanCriterion,
  PlanDiff,
  PlanRevision,
  PlanRevisionStatus,
  PlanRevisionSummary,
  PlanReview,
  PlanStatus,
  ReviewVerdict,
} from "@switchyard/shared";

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
