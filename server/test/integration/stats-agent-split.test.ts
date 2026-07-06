// SWY-138 integration tests: agent-vs-human throughput split + the
// closed-by-actor leaderboard.
//
//   DATABASE_URL_TEST=postgres://...:5432/switchyard_test \
//     bun --cwd server test test/integration/stats-agent-split.test.ts
//
// Covers: per-bucket agent/human counts sum to count, window totals, the
// null-actor → agent bucketing rule, leaderboard ordering + UserRef shape,
// and read-scope (member sees only their projects' closures).

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
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
    name: "stats-split-test",
    hashed_token: hash,
    token_prefix: prefix,
    scopes,
  });
  return token;
}

function GET(path: string, token: string) {
  return app.request(path, { headers: { authorization: `Bearer ${token}` } });
}

afterAll(async () => {
  await closeTestDb();
});

beforeEach(async () => {
  await testDb.execute(
    sql`TRUNCATE events, ticket_labels, comments, attachments, tickets,
        boards, project_counters, statuses, status_transitions, labels, projects,
        api_tokens, idempotency_keys, user_projects, users
        RESTART IDENTITY CASCADE`,
  );
});

// Fixture: owner magos (human), agent claude, one project, one closed status,
// and a pile of ticket.closed events attributed to different actors.
async function fixture() {
  const [magos] = await testDb.insert(schema.users)
    .values({ name: "magos", type: "human", instance_role: "owner" })
    .returning();
  const [claude] = await testDb.insert(schema.users)
    .values({ name: "claude", type: "agent" })
    .returning();
  const [project] = await testDb.insert(schema.projects)
    .values({ key: "SPL", name: "Split test" })
    .returning();
  await testDb.insert(schema.projectCounters).values({ project_id: project!.id });
  const [closed] = await testDb.insert(schema.statuses).values({
    project_id: project!.id, category: "closed", display_name: "Closed",
    position: 0, is_default: true,
  }).returning();
  const [ticket] = await testDb.insert(schema.tickets).values({
    project_id: project!.id, number: 1, type: "task", title: "T-1",
    status_id: closed!.id, reporter_id: magos!.id,
    // A DB trigger enforces resolution-on-closed even for direct inserts.
    resolution: "done",
  }).returning();
  return { magos: magos!, claude: claude!, project: project!, ticket: ticket! };
}

async function insertClosedEvent(
  projectId: string,
  ticketId: string,
  actorId: string | null,
  at: string,
) {
  await testDb.insert(schema.events).values({
    project_id: projectId,
    ticket_id: ticketId,
    event_type: "ticket.closed",
    actor_id: actorId,
    payload: {},
    created_at: at,
  });
}

describe("SWY-138 throughput agent/human split", () => {
  test("per-bucket split sums to count; window totals correct; null actor buckets as agent", async () => {
    const fx = await fixture();
    const at = "2026-07-01T12:00:00.000Z"; // one bucket, mid-week

    // 3 agent closes + 2 human closes + 1 system (null actor) close.
    for (let i = 0; i < 3; i++) await insertClosedEvent(fx.project.id, fx.ticket.id, fx.claude.id, at);
    for (let i = 0; i < 2; i++) await insertClosedEvent(fx.project.id, fx.ticket.id, fx.magos.id, at);
    await insertClosedEvent(fx.project.id, fx.ticket.id, null, at);

    const token = await mintToken(fx.magos.id, ["tickets:read"]);
    const res = await GET(
      "/v1/stats/throughput?since=2026-06-28T00:00:00.000Z&until=2026-07-05T00:00:00.000Z",
      token,
    );
    expect(res.status).toBe(200);
    const data = await res.json() as {
      points: Array<{ count: number; agent_count: number; human_count: number }>;
      total: number; agent_total: number; human_total: number;
    };

    expect(data.total).toBe(6);
    // null-actor closes are machines for attribution → agent bucket.
    expect(data.agent_total).toBe(4);
    expect(data.human_total).toBe(2);
    for (const p of data.points) {
      expect(p.agent_count + p.human_count).toBe(p.count);
    }
  });

  test("empty window keeps the invariant shape", async () => {
    const fx = await fixture();
    const token = await mintToken(fx.magos.id, ["tickets:read"]);
    const res = await GET(
      "/v1/stats/throughput?since=2020-01-01T00:00:00.000Z&until=2020-02-01T00:00:00.000Z",
      token,
    );
    expect(res.status).toBe(200);
    const data = await res.json() as { total: number; agent_total: number; human_total: number; points: unknown[] };
    expect(data.points).toHaveLength(0);
    expect(data.total).toBe(0);
    expect(data.agent_total).toBe(0);
    expect(data.human_total).toBe(0);
  });
});

describe("SWY-138 closed-by-actor leaderboard", () => {
  test("counts per closing actor, sorted desc, UserRef carries type; null actors omitted", async () => {
    const fx = await fixture();
    const at = "2026-07-01T12:00:00.000Z";

    for (let i = 0; i < 5; i++) await insertClosedEvent(fx.project.id, fx.ticket.id, fx.claude.id, at);
    for (let i = 0; i < 2; i++) await insertClosedEvent(fx.project.id, fx.ticket.id, fx.magos.id, at);
    await insertClosedEvent(fx.project.id, fx.ticket.id, null, at); // system — not in the list

    const token = await mintToken(fx.magos.id, ["tickets:read"]);
    const res = await GET(
      "/v1/stats/closed-by-actor?since=2026-06-28T00:00:00.000Z&until=2026-07-05T00:00:00.000Z",
      token,
    );
    expect(res.status).toBe(200);
    const data = await res.json() as {
      items: Array<{ user: { name: string; type: string }; closed: number }>;
    };

    expect(data.items).toHaveLength(2);
    expect(data.items[0]!.user.name).toBe("claude");
    expect(data.items[0]!.user.type).toBe("agent");
    expect(data.items[0]!.closed).toBe(5);
    expect(data.items[1]!.user.name).toBe("magos");
    expect(data.items[1]!.user.type).toBe("human");
    expect(data.items[1]!.closed).toBe(2);
  });

  test("attribute=assignee credits the assignee, falls back to closing actor when unassigned", async () => {
    const fx = await fixture();
    const at = "2026-07-01T12:00:00.000Z";

    // An automation agent that executes closes it shouldn't get credit for.
    const [poller] = await testDb.insert(schema.users)
      .values({ name: "external-ref-poller", type: "agent" })
      .returning();

    // Ticket assigned to claude, but every close transition is performed by
    // the poller (the PR-merge auto-close shape).
    const [assigned] = await testDb.insert(schema.tickets).values({
      project_id: fx.project.id, number: 2, type: "task", title: "T-2",
      status_id: fx.ticket.status_id, reporter_id: fx.magos.id,
      assignee_id: fx.claude.id, resolution: "done",
    }).returning();
    for (let i = 0; i < 3; i++) await insertClosedEvent(fx.project.id, assigned!.id, poller!.id, at);
    // The fixture ticket is unassigned: closes fall back to the actor.
    for (let i = 0; i < 2; i++) await insertClosedEvent(fx.project.id, fx.ticket.id, fx.magos.id, at);

    const token = await mintToken(fx.magos.id, ["tickets:read"]);
    const window = "since=2026-06-28T00:00:00.000Z&until=2026-07-05T00:00:00.000Z";

    const res = await GET(`/v1/stats/closed-by-actor?${window}&attribute=assignee`, token);
    expect(res.status).toBe(200);
    const data = await res.json() as {
      items: Array<{ user: { name: string; type: string }; closed: number }>;
    };
    expect(data.items).toHaveLength(2);
    expect(data.items[0]!.user.name).toBe("claude"); // assignee credited, not the poller
    expect(data.items[0]!.closed).toBe(3);
    expect(data.items[1]!.user.name).toBe("magos");  // unassigned → actor fallback
    expect(data.items[1]!.closed).toBe(2);

    // Default attribution is unchanged: the poller keeps its actor credit.
    const resActor = await GET(`/v1/stats/closed-by-actor?${window}`, token);
    const actorData = await resActor.json() as {
      items: Array<{ user: { name: string }; closed: number }>;
    };
    expect(actorData.items[0]!.user.name).toBe("external-ref-poller");
    expect(actorData.items[0]!.closed).toBe(3);
  });

  test("member scope: only visible projects' closures count", async () => {
    const fx = await fixture();
    const at = "2026-07-01T12:00:00.000Z";
    await insertClosedEvent(fx.project.id, fx.ticket.id, fx.claude.id, at);

    // A member with NO project memberships sees an empty leaderboard, not
    // the instance-wide fallback.
    const [outsider] = await testDb.insert(schema.users)
      .values({ name: "outsider", type: "human", instance_role: "member" })
      .returning();
    const token = await mintToken(outsider!.id, ["tickets:read"]);
    const res = await GET(
      "/v1/stats/closed-by-actor?since=2026-06-28T00:00:00.000Z&until=2026-07-05T00:00:00.000Z",
      token,
    );
    expect(res.status).toBe(200);
    const data = await res.json() as { items: unknown[] };
    expect(data.items).toHaveLength(0);
  });
});

describe("SWY-152 in_progress_agent count", () => {
  test("counts only in-progress tickets assigned to agent users, on both endpoints", async () => {
    const fx = await fixture();
    const [inProgress] = await testDb.insert(schema.statuses).values({
      project_id: fx.project.id, category: "in_progress", display_name: "In Progress",
      position: 1, is_default: false,
    }).returning();

    // 2 agent-assigned + 1 human-assigned + 1 unassigned, all in_progress.
    const rows = [
      { number: 10, assignee_id: fx.claude.id },
      { number: 11, assignee_id: fx.claude.id },
      { number: 12, assignee_id: fx.magos.id },
      { number: 13, assignee_id: null },
    ];
    for (const r of rows) {
      await testDb.insert(schema.tickets).values({
        project_id: fx.project.id, number: r.number, type: "task",
        title: `T-${r.number}`, status_id: inProgress!.id,
        reporter_id: fx.magos.id, assignee_id: r.assignee_id,
      });
    }

    const token = await mintToken(fx.magos.id, ["tickets:read"]);

    const perProject = await GET("/v1/projects/SPL/stats", token);
    expect(perProject.status).toBe(200);
    const pData = await perProject.json() as {
      by_category: { in_progress: number }; in_progress_agent: number;
    };
    expect(pData.by_category.in_progress).toBe(4);
    expect(pData.in_progress_agent).toBe(2);

    const bulk = await GET("/v1/stats/projects", token);
    expect(bulk.status).toBe(200);
    const bData = await bulk.json() as {
      items: Array<{ project: { key: string }; in_progress_agent: number }>;
    };
    const spl = bData.items.find((i) => i.project.key === "SPL");
    expect(spl?.in_progress_agent).toBe(2);
  });
});
