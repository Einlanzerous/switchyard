import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { and, asc, eq, inArray } from "drizzle-orm";
import {
  Pagination,
  Plan,
  PlanListItem,
  PlanRevision,
  PlanRevisionSummary,
  PlanStatus,
  SubmitRevisionInput,
  SubmitReviewInput,
  paginated,
} from "@switchyard/shared";
import { db } from "../db.js";
import * as schema from "../../drizzle/schema.js";
import { requireAuth } from "../auth.js";
import { errorResponses, okJson, createdJson, checkScope, z, idempotencyHeader } from "./_helpers.js";
import { mapUserRef } from "../lib/mappers.js";
import { resolveTicket } from "../lib/lookups.js";
import { loadTicketSummary } from "../lib/tickets.js";
import { writeEvent } from "../lib/events.js";
import { assertProjectReadable, assertProjectRole } from "../lib/authz.js";
import {
  listPlansApi,
  loadPlanForTicket,
  loadRevisionApi,
  mapPlan,
  mapPlanRevisionSummary,
  reviewOutcome,
} from "../lib/plans.js";
import { conflict, notFound } from "../errors.js";

const tag = "Plans";
const idOrKey = z.string().min(1);
const revNumber = z.coerce.number().int().positive();

// Cross-ticket plans collection (review queue + board badge index). Filters:
// `status` (comma-separated PlanStatus list), `project` (key scope),
// `awaiting_my_review` (in_review plans in projects the caller can write).
const ListPlansQuery = Pagination.extend({
  status: z.string().optional(),
  project: z.string().optional(),
  awaiting_my_review: z.coerce.boolean().optional(),
});

const listPlans = createRoute({
  method: "get", path: "/v1/plans", tags: [tag],
  summary: "List plans across tickets (review queue / board badge index)",
  request: { query: ListPlansQuery },
  responses: { ...okJson(paginated(PlanListItem)), ...errorResponses },
});

const getPlan = createRoute({
  method: "get", path: "/v1/tickets/{idOrKey}/plan", tags: [tag],
  summary: "Get a ticket's plan (with its current revision)",
  request: { params: z.object({ idOrKey }) },
  responses: { ...okJson(Plan), ...errorResponses },
});

const submitRevision = createRoute({
  method: "post", path: "/v1/tickets/{idOrKey}/plan/revisions", tags: [tag],
  summary: "Submit a plan revision (creates the plan on the first call)",
  request: {
    params: z.object({ idOrKey }),
    headers: idempotencyHeader,
    body: { content: { "application/json": { schema: SubmitRevisionInput } } },
  },
  responses: { ...createdJson(PlanRevision), ...errorResponses },
});

const listRevisions = createRoute({
  method: "get", path: "/v1/tickets/{idOrKey}/plan/revisions", tags: [tag],
  summary: "List a plan's revisions (newest first)",
  request: { params: z.object({ idOrKey }) },
  responses: { ...okJson(paginated(PlanRevisionSummary)), ...errorResponses },
});

const getRevision = createRoute({
  method: "get", path: "/v1/tickets/{idOrKey}/plan/revisions/{rev}", tags: [tag],
  summary: "Get one plan revision (with diff against the previous revision)",
  request: { params: z.object({ idOrKey, rev: revNumber }) },
  responses: { ...okJson(PlanRevision), ...errorResponses },
});

const reviewRevision = createRoute({
  method: "post", path: "/v1/tickets/{idOrKey}/plan/revisions/{rev}/review", tags: [tag],
  summary: "Review the current plan revision (per-criterion + overall verdict)",
  request: {
    params: z.object({ idOrKey, rev: revNumber }),
    headers: idempotencyHeader,
    body: { content: { "application/json": { schema: SubmitReviewInput } } },
  },
  responses: { ...okJson(PlanRevision), ...errorResponses },
});

export function mount(app: OpenAPIHono) {
  // The ticket-rooted routes live under /v1/tickets/* — the requireAuth +
  // idempotency wildcards registered by tickets.mount() already cover them
  // (mounted after tickets in mountRoutes, so the middleware is registered
  // first). The top-level /v1/plans collection is outside that wildcard, so it
  // needs its own auth gate (read-only GET → no idempotency).
  app.use("/v1/plans", requireAuth);

  // GET cross-ticket plans collection.
  app.openapi(listPlans, (async (c: any) => {
    const q = c.req.valid("query");
    const auth = c.get("auth");
    const statuses = q.status
      ? (q.status.split(",").map((s: string) => s.trim()).filter((s: string) =>
          (PlanStatus.options as readonly string[]).includes(s),
        ) as PlanStatus[])
      : undefined;
    const page = await listPlansApi(auth.user, {
      statuses,
      projectKey: q.project,
      awaitingMyReview: q.awaiting_my_review ?? false,
      limit: q.limit,
      cursor: q.cursor ?? null,
    });
    return c.json(page, 200);
  }) as any);

  // GET plan + current revision.
  app.openapi(getPlan, (async (c: any) => {
    const { idOrKey: param } = c.req.valid("param");
    const ticket = await resolveTicket(param);
    await assertProjectReadable(c.get("auth").user, ticket.project_id, "plan");
    const plan = await loadPlanForTicket(ticket.id);
    if (!plan) throw notFound("plan");
    return c.json(plan, 200);
  }) as any);

  // Submit a new revision (creates the plan on the first call).
  app.openapi(submitRevision, (async (c: any) => {
    checkScope(c, "tickets:write");
    const { idOrKey: param } = c.req.valid("param");
    const body = c.req.valid("json");
    const auth = c.get("auth");
    const ticket = await resolveTicket(param);
    await assertProjectRole(auth.user, ticket.project_id, "write", "plan");

    const newRevId = await db.transaction(async (tx) => {
      const [existing] = await tx.select().from(schema.plans)
        .where(eq(schema.plans.ticket_id, ticket.id))
        .limit(1);

      // An approved plan is terminal in 7.0 — re-opening for further revisions
      // is a 7.2 concern (policy + transition wiring). Reject the revise here so
      // an approved blueprint can't be silently mutated out from under a build.
      if (existing && existing.status === "approved") {
        throw conflict("plan already approved; cannot submit further revisions", {
          plan_id: existing.id,
        });
      }

      const isFirst = !existing;
      let planId: string;
      let revNum: number;

      if (!existing) {
        const [plan] = await tx.insert(schema.plans).values({
          ticket_id: ticket.id,
          status: "in_review",
          revision_count: 0,
        }).returning();
        if (!plan) throw new Error("plan insert returned nothing");
        planId = plan.id;
        revNum = 1;
      } else {
        planId = existing.id;
        revNum = existing.revision_count + 1;
      }

      const [rev] = await tx.insert(schema.planRevisions).values({
        plan_id: planId,
        rev_number: revNum,
        narrative_md: body.narrative_md,
        status: "in_review",
        submitted_by: auth.user.id,
      }).returning();
      if (!rev) throw new Error("plan revision insert returned nothing");

      await tx.insert(schema.planCriteria).values(
        body.criteria.map((cr: { text: string }, i: number) => ({
          revision_id: rev.id,
          position: i,
          text: cr.text,
        })),
      );

      // Repoint the plan at the new current revision; bump count + reset status
      // to in_review (a revise pulls an in-review/changes-requested plan back
      // into review).
      await tx.update(schema.plans)
        .set({ current_revision_id: rev.id, revision_count: revNum, status: "in_review" })
        .where(eq(schema.plans.id, planId));

      const summary = await loadTicketSummary(ticket, tx as any);
      await writeEvent(tx as any, {
        event_type: isFirst ? "plan.submitted" : "plan.revised",
        actor: mapUserRef(auth.user),
        ticket: summary,
        project_id: ticket.project_id,
        extras: { plan_id: planId, revision_id: rev.id, rev_number: revNum, plan_status: "in_review" },
      });

      return rev.id;
    });

    const [rev] = await db.select().from(schema.planRevisions).where(eq(schema.planRevisions.id, newRevId)).limit(1);
    return c.json(await loadRevisionApi(rev!, { withDiff: true }), 201);
  }) as any);

  // List revisions (newest first).
  app.openapi(listRevisions, (async (c: any) => {
    const { idOrKey: param } = c.req.valid("param");
    const ticket = await resolveTicket(param);
    await assertProjectReadable(c.get("auth").user, ticket.project_id, "plan");
    const [plan] = await db.select().from(schema.plans).where(eq(schema.plans.ticket_id, ticket.id)).limit(1);
    if (!plan) throw notFound("plan");

    const revs = await db.select().from(schema.planRevisions)
      .where(eq(schema.planRevisions.plan_id, plan.id))
      .orderBy(asc(schema.planRevisions.rev_number));
    const userIds = [...new Set(revs.map((r) => r.submitted_by))];
    const users = userIds.length > 0
      ? await db.select().from(schema.users).where(inArray(schema.users.id, userIds))
      : [];
    const userById = new Map(users.map((u) => [u.id, u]));

    // Newest first for display; the plan's revision history reads top-down.
    const items = [...revs].reverse().map((r) => mapPlanRevisionSummary(r, userById.get(r.submitted_by)!));
    return c.json({ items, page: { next_cursor: null, has_more: false } }, 200);
  }) as any);

  // Get one revision with its diff-since-previous.
  app.openapi(getRevision, (async (c: any) => {
    const { idOrKey: param, rev: revNum } = c.req.valid("param");
    const ticket = await resolveTicket(param);
    await assertProjectReadable(c.get("auth").user, ticket.project_id, "plan");
    const [plan] = await db.select().from(schema.plans).where(eq(schema.plans.ticket_id, ticket.id)).limit(1);
    if (!plan) throw notFound("plan");

    const [rev] = await db.select().from(schema.planRevisions)
      .where(and(eq(schema.planRevisions.plan_id, plan.id), eq(schema.planRevisions.rev_number, revNum)))
      .limit(1);
    if (!rev) throw notFound("plan revision");
    return c.json(await loadRevisionApi(rev, { withDiff: true }), 200);
  }) as any);

  // Review the current revision.
  app.openapi(reviewRevision, (async (c: any) => {
    checkScope(c, "tickets:write");
    const { idOrKey: param, rev: revNum } = c.req.valid("param");
    const body = c.req.valid("json");
    const auth = c.get("auth");
    const ticket = await resolveTicket(param);
    await assertProjectRole(auth.user, ticket.project_id, "write", "plan");

    await db.transaction(async (tx) => {
      const [plan] = await tx.select().from(schema.plans).where(eq(schema.plans.ticket_id, ticket.id)).limit(1);
      if (!plan) throw notFound("plan");

      const [rev] = await tx.select().from(schema.planRevisions)
        .where(and(eq(schema.planRevisions.plan_id, plan.id), eq(schema.planRevisions.rev_number, revNum)))
        .limit(1);
      if (!rev) throw notFound("plan revision");

      // Only the current revision is reviewable, and only while it's in review —
      // a settled (approved/changes_requested/rejected) revision is immutable.
      if (rev.id !== plan.current_revision_id) {
        throw conflict("only the current revision can be reviewed", { current_revision_id: plan.current_revision_id });
      }
      if (rev.status !== "in_review") {
        throw conflict(`revision ${revNum} has already been reviewed (status: ${rev.status})`);
      }

      // Apply per-criterion verdicts (by position within this revision). Unlisted
      // criteria stay `pending`.
      for (const cv of body.criteria_verdicts ?? []) {
        await tx.update(schema.planCriteria)
          .set({ verdict: cv.verdict, reviewer_note: cv.reviewer_note ?? null })
          .where(and(eq(schema.planCriteria.revision_id, rev.id), eq(schema.planCriteria.position, cv.position)));
      }

      const outcome = reviewOutcome(body.verdict);

      await tx.insert(schema.planReviews).values({
        revision_id: rev.id,
        reviewer_id: auth.user.id,
        verdict: body.verdict,
        note: body.note ?? null,
      });

      await tx.update(schema.planRevisions).set({ status: outcome.revisionStatus }).where(eq(schema.planRevisions.id, rev.id));
      await tx.update(schema.plans).set({ status: outcome.planStatus }).where(eq(schema.plans.id, plan.id));

      const summary = await loadTicketSummary(ticket, tx as any);
      await writeEvent(tx as any, {
        event_type: outcome.eventType,
        actor: mapUserRef(auth.user),
        ticket: summary,
        project_id: ticket.project_id,
        extras: {
          plan_id: plan.id,
          revision_id: rev.id,
          rev_number: rev.rev_number,
          plan_status: outcome.planStatus,
          verdict: body.verdict,
        },
      });
    });

    const [plan] = await db.select({ id: schema.plans.id }).from(schema.plans)
      .where(eq(schema.plans.ticket_id, ticket.id)).limit(1);
    const [rev] = await db.select().from(schema.planRevisions)
      .where(and(eq(schema.planRevisions.plan_id, plan!.id), eq(schema.planRevisions.rev_number, revNum)))
      .limit(1);
    return c.json(await loadRevisionApi(rev!, { withDiff: true }), 200);
  }) as any);
}
