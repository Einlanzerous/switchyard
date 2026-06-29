// Plan-as-PR REST integration (SWY-109). Drives the real Hono app over HTTP:
// the submit → review → revise loop, the plan/revision state machine + diff,
// event emission (with no rule loop), and the Phase 6 authz gates.
//
//   DATABASE_URL_TEST=postgres://...:5432/switchyard_test \
//     bun --cwd server test test/integration/plans.test.ts

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { and, eq, like, sql } from "drizzle-orm";
import { closeTestDb, schema, testDb } from "../db.js";

process.env.DATABASE_URL = process.env.DATABASE_URL_TEST!;

const { OpenAPIHono } = await import("@hono/zod-openapi");
const { installErrorHandler } = await import("../../src/errors.js");
const { mountRoutes } = await import("../../src/routes/index.js");
const { generateApiToken } = await import("../../src/lib/id.js");

function buildApp() {
  const app = new OpenAPIHono();
  installErrorHandler(app);
  mountRoutes(app);
  return app;
}
const app = buildApp();

async function mintToken(userId: string, scopes: string[]): Promise<string> {
  const { token, hash, prefix } = generateApiToken();
  await testDb.insert(schema.apiTokens).values({
    user_id: userId,
    name: "plans-test",
    hashed_token: hash,
    token_prefix: prefix,
    scopes,
  });
  return token;
}

const GET = (path: string, token: string) =>
  app.request(path, { headers: { authorization: `Bearer ${token}` } });
const POST = (path: string, token: string, json: unknown) =>
  app.request(path, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(json),
  });

afterAll(async () => {
  await closeTestDb();
});

beforeEach(async () => {
  await testDb.execute(
    sql`TRUNCATE plan_reviews, plan_criteria, plan_revisions, plans,
        events, ticket_labels, comments, attachments, tickets,
        boards, project_counters, statuses, status_transitions, labels, projects,
        api_tokens, idempotency_keys, user_projects, users,
        rules, targets, webhook_subscriptions
        RESTART IDENTITY CASCADE`,
  );
});

// Fixture: an editor + viewer (both members of SWY) and a non-member outsider,
// plus a single SWY ticket to hang a plan on.
async function seed() {
  const [editor] = await testDb.insert(schema.users)
    .values({ name: "editor", type: "human", instance_role: "member" }).returning();
  const [viewer] = await testDb.insert(schema.users)
    .values({ name: "viewer", type: "human", instance_role: "member" }).returning();
  const [outsider] = await testDb.insert(schema.users)
    .values({ name: "outsider", type: "human", instance_role: "member" }).returning();

  const [swy] = await testDb.insert(schema.projects).values({ key: "SWY", name: "Switchyard" }).returning();
  await testDb.insert(schema.projectCounters).values({ project_id: swy!.id });
  const [backlog] = await testDb.insert(schema.statuses)
    .values({ project_id: swy!.id, category: "backlog", display_name: "Backlog", position: 0, is_default: true })
    .returning();

  await testDb.insert(schema.userProjects).values([
    { user_id: editor!.id, project_id: swy!.id, role: "editor" },
    { user_id: viewer!.id, project_id: swy!.id, role: "viewer" },
  ]);

  const [ticket] = await testDb.insert(schema.tickets).values({
    project_id: swy!.id, number: 1, type: "task", title: "Build the thing",
    status_id: backlog!.id, reporter_id: editor!.id,
  }).returning();

  const editorTok = await mintToken(editor!.id, ["tickets:write"]);
  const viewerTok = await mintToken(viewer!.id, ["tickets:write"]);
  const outsiderTok = await mintToken(outsider!.id, ["tickets:write"]);

  return { editor: editor!, ticket: ticket!, editorTok, viewerTok, outsiderTok, key: "SWY-1" };
}

function planEvents(ticketId: string) {
  return testDb.select().from(schema.events)
    .where(and(eq(schema.events.ticket_id, ticketId), like(schema.events.event_type, "plan.%")));
}

describe("7.0 — plan submit / review / revise lifecycle", () => {
  test("submit creates the plan + revision 1 and emits plan.submitted", async () => {
    const { ticket, editor, editorTok, key } = await seed();

    const res = await POST(`/v1/tickets/${key}/plan/revisions`, editorTok, {
      narrative_md: "## Approach\nDo it carefully.",
      criteria: [{ text: "compiles" }, { text: "tests pass" }],
    });
    expect(res.status).toBe(201);
    const rev = await res.json();
    expect(rev.rev_number).toBe(1);
    expect(rev.status).toBe("in_review");
    expect(rev.criteria.map((c: any) => c.verdict)).toEqual(["pending", "pending"]);
    expect(rev.diff).toBeUndefined(); // no predecessor on rev 1

    const planRes = await GET(`/v1/tickets/${key}/plan`, editorTok);
    expect(planRes.status).toBe(200);
    const plan = await planRes.json();
    expect(plan.status).toBe("in_review");
    expect(plan.revision_count).toBe(1);
    expect(plan.current_revision.rev_number).toBe(1);

    const evs = await planEvents(ticket.id);
    expect(evs.map((e) => e.event_type)).toEqual(["plan.submitted"]);
    // No rule loop: the actor is the editor, never the rules-engine.
    expect(evs[0]!.actor_id).toBe(editor.id);
  });

  test("changes_requested → revise increments rev_number, plan back to in_review, diff present", async () => {
    const { ticket, editorTok, key } = await seed();

    await POST(`/v1/tickets/${key}/plan/revisions`, editorTok, {
      narrative_md: "v1 narrative",
      criteria: [{ text: "a" }, { text: "b" }],
    });
    const review = await POST(`/v1/tickets/${key}/plan/revisions/1/review`, editorTok, {
      verdict: "changes_requested",
      note: "tighten the approach",
      criteria_verdicts: [{ position: 1, verdict: "rejected", reviewer_note: "vague" }],
    });
    expect(review.status).toBe(200);
    expect((await review.json()).status).toBe("changes_requested");

    let plan = await (await GET(`/v1/tickets/${key}/plan`, editorTok)).json();
    expect(plan.status).toBe("changes_requested");
    // The per-criterion verdict landed; the unlisted one stays pending.
    expect(plan.current_revision.criteria.find((c: any) => c.text === "b").verdict).toBe("rejected");
    expect(plan.current_revision.criteria.find((c: any) => c.text === "a").verdict).toBe("pending");

    const rev2 = await POST(`/v1/tickets/${key}/plan/revisions`, editorTok, {
      narrative_md: "v2 narrative",
      criteria: [{ text: "a" }, { text: "b2" }],
    });
    expect(rev2.status).toBe(201);
    const r2 = await rev2.json();
    expect(r2.rev_number).toBe(2);
    expect(r2.diff.from_rev_number).toBe(1);

    plan = await (await GET(`/v1/tickets/${key}/plan`, editorTok)).json();
    expect(plan.status).toBe("in_review");
    expect(plan.revision_count).toBe(2);

    const types = (await planEvents(ticket.id)).map((e) => e.event_type);
    expect(types).toEqual(["plan.submitted", "plan.changes_requested", "plan.revised"]);
  });

  test("approve → plan approved + plan.approved; further revise is 409", async () => {
    const { ticket, editorTok, key } = await seed();
    await POST(`/v1/tickets/${key}/plan/revisions`, editorTok, {
      narrative_md: "ship it", criteria: [{ text: "works" }],
    });
    const review = await POST(`/v1/tickets/${key}/plan/revisions/1/review`, editorTok, {
      verdict: "approved",
      criteria_verdicts: [{ position: 0, verdict: "approved" }],
    });
    expect(review.status).toBe(200);

    const plan = await (await GET(`/v1/tickets/${key}/plan`, editorTok)).json();
    expect(plan.status).toBe("approved");
    expect(plan.current_revision.criteria[0].verdict).toBe("approved");

    const blocked = await POST(`/v1/tickets/${key}/plan/revisions`, editorTok, {
      narrative_md: "sneaky change", criteria: [{ text: "x" }],
    });
    expect(blocked.status).toBe(409);

    const types = (await planEvents(ticket.id)).map((e) => e.event_type);
    expect(types).toEqual(["plan.submitted", "plan.approved"]);
  });

  test("rejected verdict emits the distinct plan.rejected event, plan returns to rework", async () => {
    const { ticket, editorTok, key } = await seed();
    await POST(`/v1/tickets/${key}/plan/revisions`, editorTok, {
      narrative_md: "wrong approach", criteria: [{ text: "x" }],
    });
    const review = await POST(`/v1/tickets/${key}/plan/revisions/1/review`, editorTok, {
      verdict: "rejected", note: "rethink this entirely",
    });
    expect(review.status).toBe(200);
    expect((await review.json()).status).toBe("rejected");

    const plan = await (await GET(`/v1/tickets/${key}/plan`, editorTok)).json();
    expect(plan.status).toBe("changes_requested");
    const types = (await planEvents(ticket.id)).map((e) => e.event_type);
    expect(types).toEqual(["plan.submitted", "plan.rejected"]);
  });
});

describe("7.0 — review guards", () => {
  test("reviewing an already-reviewed revision → 409", async () => {
    const { editorTok, key } = await seed();
    await POST(`/v1/tickets/${key}/plan/revisions`, editorTok, {
      narrative_md: "n", criteria: [{ text: "x" }],
    });
    await POST(`/v1/tickets/${key}/plan/revisions/1/review`, editorTok, { verdict: "changes_requested" });
    const second = await POST(`/v1/tickets/${key}/plan/revisions/1/review`, editorTok, { verdict: "approved" });
    expect(second.status).toBe(409);
  });

  test("reviewing a non-current (superseded) revision → 409", async () => {
    const { editorTok, key } = await seed();
    await POST(`/v1/tickets/${key}/plan/revisions`, editorTok, { narrative_md: "v1", criteria: [{ text: "x" }] });
    await POST(`/v1/tickets/${key}/plan/revisions/1/review`, editorTok, { verdict: "changes_requested" });
    await POST(`/v1/tickets/${key}/plan/revisions`, editorTok, { narrative_md: "v2", criteria: [{ text: "y" }] });
    // Revision 1 is no longer current; reviewing it must 409.
    const res = await POST(`/v1/tickets/${key}/plan/revisions/1/review`, editorTok, { verdict: "approved" });
    expect(res.status).toBe(409);
  });
});

describe("7.0 — authz (reuses Phase 6)", () => {
  test("viewer cannot submit a plan (403 even with tickets:write token)", async () => {
    const { viewerTok, key } = await seed();
    const res = await POST(`/v1/tickets/${key}/plan/revisions`, viewerTok, {
      narrative_md: "n", criteria: [{ text: "x" }],
    });
    expect(res.status).toBe(403);
  });

  test("non-member reads 404 (existence hidden), writes 403", async () => {
    const { editorTok, outsiderTok, key } = await seed();
    // Editor seeds a plan so there's something to (not) see.
    await POST(`/v1/tickets/${key}/plan/revisions`, editorTok, {
      narrative_md: "n", criteria: [{ text: "x" }],
    });
    expect((await GET(`/v1/tickets/${key}/plan`, outsiderTok)).status).toBe(404);
    const write = await POST(`/v1/tickets/${key}/plan/revisions`, outsiderTok, {
      narrative_md: "n", criteria: [{ text: "x" }],
    });
    expect(write.status).toBe(403);
  });

  test("GET plan on a ticket with no plan → 404", async () => {
    const { editorTok, key } = await seed();
    expect((await GET(`/v1/tickets/${key}/plan`, editorTok)).status).toBe(404);
  });
});

// ─── 7.1 — plan-anchored comments ──────────────────────────────────────────────

describe("7.1 — plan-anchored comments", () => {
  // Seed + submit revision 1 + a token that can write comments.
  async function seedWithPlan() {
    const s = await seed();
    const commentTok = await mintToken(s.editor.id, ["tickets:write", "comments:write"]);
    const rev = await (await POST(`/v1/tickets/${s.key}/plan/revisions`, s.editorTok, {
      narrative_md: "## Approach\nDo it.",
      criteria: [{ text: "a" }, { text: "b" }],
    })).json();
    return { ...s, commentTok, rev };
  }

  test("anchored comments surface on the revision thread, hidden from the ticket thread", async () => {
    const { key, commentTok, rev } = await seedWithPlan();
    const criterionId = rev.criteria[0].id;

    await POST(`/v1/tickets/${key}/comments`, commentTok, { body: "plain ticket comment" });
    const a1 = await POST(`/v1/tickets/${key}/comments`, commentTok, {
      body: "looks good overall", plan_revision_id: rev.id, plan_anchor: "plan",
    });
    expect(a1.status).toBe(201);
    expect((await a1.json()).plan_revision_id).toBe(rev.id);

    const a2 = await POST(`/v1/tickets/${key}/comments`, commentTok, {
      body: "tighten this AC", plan_revision_id: rev.id, plan_anchor: `criterion:${criterionId}`,
    });
    expect(a2.status).toBe(201);
    expect((await a2.json()).plan_anchor).toBe(`criterion:${criterionId}`);

    // Ticket thread shows ONLY the plain comment.
    const ticketThread = await (await GET(`/v1/tickets/${key}/comments`, commentTok)).json();
    expect(ticketThread.items.map((c: any) => c.body)).toEqual(["plain ticket comment"]);

    // Revision thread shows the two anchored comments.
    const revThread = await (await GET(`/v1/tickets/${key}/comments?plan_revision_id=${rev.id}`, commentTok)).json();
    expect(revThread.items).toHaveLength(2);
    expect(revThread.items.every((c: any) => c.plan_revision_id === rev.id)).toBe(true);

    // Narrowed to the criterion anchor.
    const critThread = await (await GET(
      `/v1/tickets/${key}/comments?plan_revision_id=${rev.id}&anchor=criterion:${criterionId}`, commentTok,
    )).json();
    expect(critThread.items).toHaveLength(1);
    expect(critThread.items[0].body).toBe("tighten this AC");
  });

  test("plan_anchor without plan_revision_id → 400", async () => {
    const { key, commentTok } = await seedWithPlan();
    const res = await POST(`/v1/tickets/${key}/comments`, commentTok, { body: "oops", plan_anchor: "plan" });
    expect(res.status).toBe(400);
  });

  test("criterion anchor referencing a non-existent criterion → 400", async () => {
    const { key, commentTok, rev } = await seedWithPlan();
    const res = await POST(`/v1/tickets/${key}/comments`, commentTok, {
      body: "x", plan_revision_id: rev.id, plan_anchor: "criterion:00000000-0000-0000-0000-000000000000",
    });
    expect(res.status).toBe(400);
  });

  test("anchoring to a revision rooted on another ticket → 400", async () => {
    const { key, commentTok, rev, editor } = await seedWithPlan();
    // A second ticket in the same project, with no plan of its own.
    const [proj] = await testDb.select().from(schema.projects).where(eq(schema.projects.key, "SWY"));
    const [status] = await testDb.select().from(schema.statuses).where(eq(schema.statuses.project_id, proj!.id));
    await testDb.insert(schema.tickets).values({
      project_id: proj!.id, number: 2, type: "task", title: "Other", status_id: status!.id, reporter_id: editor.id,
    });
    // SWY-1's revision can't anchor a comment on SWY-2.
    const res = await POST(`/v1/tickets/SWY-2/comments`, commentTok, {
      body: "cross-ticket", plan_revision_id: rev.id, plan_anchor: "plan",
    });
    expect(res.status).toBe(400);
    expect(key).toBe("SWY-1"); // sanity: the revision really belongs to SWY-1
  });
});

// ─── 7.1 — GET /v1/plans collection ────────────────────────────────────────────

describe("7.1 — GET /v1/plans collection", () => {
  test("lists readable plans; filters by status; awaiting_my_review scopes to in_review", async () => {
    const { editorTok, key } = await seed();

    // No plans yet → empty page.
    expect((await (await GET(`/v1/plans`, editorTok)).json()).items).toEqual([]);

    await POST(`/v1/tickets/${key}/plan/revisions`, editorTok, {
      narrative_md: "n", criteria: [{ text: "a" }, { text: "b" }],
    });

    const list = await (await GET(`/v1/plans`, editorTok)).json();
    expect(list.items).toHaveLength(1);
    const item = list.items[0];
    expect(item.ticket.key).toBe(key);
    expect(item.status).toBe("in_review");
    expect(item.current_revision.rev_number).toBe(1);
    expect(item.current_revision.criteria_total).toBe(2);
    expect(item.current_revision.criteria_pending).toBe(2);

    // The editor's review queue surfaces the in_review plan.
    expect((await (await GET(`/v1/plans?awaiting_my_review=true`, editorTok)).json()).items).toHaveLength(1);
    // status=approved filters out an in_review plan.
    expect((await (await GET(`/v1/plans?status=approved`, editorTok)).json()).items).toEqual([]);

    // Approve it → drops out of the review queue, appears under status=approved.
    await POST(`/v1/tickets/${key}/plan/revisions/1/review`, editorTok, {
      verdict: "approved",
      criteria_verdicts: [{ position: 0, verdict: "approved" }, { position: 1, verdict: "approved" }],
    });
    expect((await (await GET(`/v1/plans?awaiting_my_review=true`, editorTok)).json()).items).toEqual([]);
    expect((await (await GET(`/v1/plans?status=approved`, editorTok)).json()).items).toHaveLength(1);
  });

  test("viewer reads the plan but their review queue is empty (no write role)", async () => {
    const { editorTok, viewerTok, key } = await seed();
    await POST(`/v1/tickets/${key}/plan/revisions`, editorTok, { narrative_md: "n", criteria: [{ text: "a" }] });
    expect((await (await GET(`/v1/plans`, viewerTok)).json()).items).toHaveLength(1);
    expect((await (await GET(`/v1/plans?awaiting_my_review=true`, viewerTok)).json()).items).toEqual([]);
  });

  test("non-member sees nothing (visibility scoping)", async () => {
    const { editorTok, outsiderTok, key } = await seed();
    await POST(`/v1/tickets/${key}/plan/revisions`, editorTok, { narrative_md: "n", criteria: [{ text: "a" }] });
    expect((await (await GET(`/v1/plans`, outsiderTok)).json()).items).toEqual([]);
  });

  test("project filter scopes to that project key", async () => {
    const { editorTok, key } = await seed();
    await POST(`/v1/tickets/${key}/plan/revisions`, editorTok, { narrative_md: "n", criteria: [{ text: "a" }] });
    expect((await (await GET(`/v1/plans?project=SWY`, editorTok)).json()).items).toHaveLength(1);
    expect((await (await GET(`/v1/plans?project=NOPE`, editorTok)).json()).items).toEqual([]);
  });
});
