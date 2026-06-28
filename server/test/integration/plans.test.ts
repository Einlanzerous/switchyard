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
