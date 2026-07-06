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
