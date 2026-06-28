import { z } from "zod";
import { Uuid, Iso8601, Timestamps } from "./common.js";
import { UserRef } from "./user.js";

// ─── Plan-as-PR (Phase 7 / SWY-108) ──────────────────────────────────────────
//
// One plan per ticket, many versioned revisions. Each revision is a hybrid
// artifact: narrative markdown (Summary / Approach / Risks) + a structured,
// individually-checkable acceptance-criteria list — the machine-checkable
// contract the build is verified against. Review is PR-style: per-criterion
// verdicts + an overall verdict, looped until approved.

export const PlanStatus = z.enum([
  "draft",
  "in_review",
  "changes_requested",
  "approved",
  "superseded",
]);
export type PlanStatus = z.infer<typeof PlanStatus>;

export const PlanRevisionStatus = z.enum([
  "in_review",
  "changes_requested",
  "approved",
  "rejected",
]);
export type PlanRevisionStatus = z.infer<typeof PlanRevisionStatus>;

// Per-criterion verdict on a response. `pending` until a review touches it.
export const CriterionVerdict = z.enum(["pending", "approved", "rejected"]);
export type CriterionVerdict = z.infer<typeof CriterionVerdict>;

// Overall review verdict. `changes_requested` = fix the flagged criteria;
// `rejected` = the approach itself is wrong (drives the distinct plan.rejected
// event so policy/rules can route it differently from a nit-fix loop).
export const ReviewVerdict = z.enum(["approved", "changes_requested", "rejected"]);
export type ReviewVerdict = z.infer<typeof ReviewVerdict>;

// Anchor pinning a plan comment thread to a sub-target within a revision:
//   `plan`            — the revision as a whole
//   `section:<name>`  — a narrative section (e.g. `section:Approach`)
//   `criterion:<id>`  — a specific acceptance criterion (uuid)
export const PlanAnchor = z
  .string()
  .regex(
    /^(plan|section:.+|criterion:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/,
    "anchor must be `plan`, `section:<name>`, or `criterion:<uuid>`"
  );
export type PlanAnchor = z.infer<typeof PlanAnchor>;

// ─── response shapes ──────────────────────────────────────────────────────────

export const PlanCriterion = z.object({
  id: Uuid,
  position: z.number().int().nonnegative(),
  text: z.string(),
  verdict: CriterionVerdict,
  reviewer_note: z.string().nullable(),
});
export type PlanCriterion = z.infer<typeof PlanCriterion>;

export const PlanReview = z.object({
  id: Uuid,
  reviewer: UserRef,
  verdict: ReviewVerdict,
  note: z.string().nullable(),
  created_at: Iso8601,
});
export type PlanReview = z.infer<typeof PlanReview>;

// Render-time diff of a revision against its predecessor (no stable per-criterion
// identity in v1 — added/removed/changed are computed from text + position).
export const PlanNarrativeDiffLine = z.object({
  type: z.enum(["context", "added", "removed"]),
  text: z.string(),
});
export type PlanNarrativeDiffLine = z.infer<typeof PlanNarrativeDiffLine>;

export const PlanCriterionDiff = z.object({
  type: z.enum(["unchanged", "added", "removed", "changed"]),
  position: z.number().int().nonnegative(),
  text: z.string(),
  // Present only for `changed` rows: the predecessor's text at this position.
  prev_text: z.string().nullable().optional(),
});
export type PlanCriterionDiff = z.infer<typeof PlanCriterionDiff>;

export const PlanDiff = z.object({
  // The rev_number this diff is computed against (null when there is no
  // predecessor, i.e. revision 1 — in which case the diff field is omitted).
  from_rev_number: z.number().int().positive().nullable(),
  narrative: z.array(PlanNarrativeDiffLine),
  criteria: z.array(PlanCriterionDiff),
});
export type PlanDiff = z.infer<typeof PlanDiff>;

export const PlanRevision = z.object({
  id: Uuid,
  rev_number: z.number().int().positive(),
  narrative_md: z.string(),
  status: PlanRevisionStatus,
  submitted_by: UserRef,
  submitted_at: Iso8601,
  criteria: z.array(PlanCriterion),
  reviews: z.array(PlanReview),
  // Diff vs the previous revision; omitted on revision 1 and on list shapes.
  diff: PlanDiff.optional(),
});
export type PlanRevision = z.infer<typeof PlanRevision>;

// Lightweight revision row for the revisions list (no criteria/reviews/diff).
export const PlanRevisionSummary = z.object({
  id: Uuid,
  rev_number: z.number().int().positive(),
  status: PlanRevisionStatus,
  submitted_by: UserRef,
  submitted_at: Iso8601,
});
export type PlanRevisionSummary = z.infer<typeof PlanRevisionSummary>;

export const Plan = z
  .object({
    id: Uuid,
    ticket_id: Uuid,
    status: PlanStatus,
    revision_count: z.number().int().nonnegative(),
    current_revision: PlanRevision,
  })
  .merge(Timestamps);
export type Plan = z.infer<typeof Plan>;

// ─── request bodies ───────────────────────────────────────────────────────────

const CriterionInput = z.object({
  text: z.string().min(1).max(2_000),
});

// Submit the first revision OR a subsequent revision (the server creates the
// plan on the first call). The full criteria list is supplied every time.
export const SubmitRevisionInput = z.object({
  narrative_md: z.string().min(1).max(100_000),
  criteria: z.array(CriterionInput).min(1).max(100),
});
export type SubmitRevisionInput = z.infer<typeof SubmitRevisionInput>;

// Per-criterion verdict input. `position` keys to the criterion's slot in the
// revision (stable within a single revision). Only approved/rejected are
// settable; unmentioned criteria stay `pending`.
const CriterionVerdictInput = z.object({
  position: z.number().int().nonnegative(),
  verdict: z.enum(["approved", "rejected"]),
  reviewer_note: z.string().max(10_000).optional(),
});

export const SubmitReviewInput = z.object({
  verdict: ReviewVerdict,
  note: z.string().max(10_000).optional(),
  criteria_verdicts: z.array(CriterionVerdictInput).max(100).optional(),
});
export type SubmitReviewInput = z.infer<typeof SubmitReviewInput>;
