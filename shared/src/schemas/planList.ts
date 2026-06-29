import { z } from "zod";
import { Uuid, Iso8601, Timestamps } from "./common.js";
import { UserRef } from "./user.js";
import { TicketSummary } from "./ticket.js";
import { PlanStatus, PlanRevisionStatus } from "./plan.js";

// ─── Plan collection (Phase 7.1) ─────────────────────────────────────────────
//
// The cross-ticket `GET /v1/plans` list that powers the homepage "Plans
// awaiting your review" widget and the board "plan in review" badge index.
// Lives in its own module (not plan.ts) so it can embed TicketSummary without
// creating a ticket → comment → plan import cycle (plan.ts must stay a leaf
// that comment.ts can import for PlanAnchor).

// Enough of the current revision to render a review-queue row without a second
// fetch: who submitted it, when, and how many criteria still await a verdict.
export const PlanListRevision = z.object({
  id: Uuid,
  rev_number: z.number().int().positive(),
  status: PlanRevisionStatus,
  submitted_by: UserRef,
  submitted_at: Iso8601,
  criteria_total: z.number().int().nonnegative(),
  criteria_pending: z.number().int().nonnegative(),
});
export type PlanListRevision = z.infer<typeof PlanListRevision>;

export const PlanListItem = z
  .object({
    id: Uuid,
    ticket: TicketSummary,
    status: PlanStatus,
    revision_count: z.number().int().nonnegative(),
    current_revision: PlanListRevision,
  })
  .merge(Timestamps);
export type PlanListItem = z.infer<typeof PlanListItem>;
