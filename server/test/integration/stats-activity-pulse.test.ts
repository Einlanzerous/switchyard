// SWY-136 integration tests: per-project activity pulse.
//
//   DATABASE_URL_TEST=postgres://...:5432/switchyard_test \
//     bun --cwd server test test/integration/stats-activity-pulse.test.ts
//
// Covers: series shape (fixed 14 UTC-day buckets, oldest → newest),
// last_activity_at (all-time, not window-bound), recent-actor ordering +
// 3-cap + UserRef.type, quiet-project zeros, and member read-scope.

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
    name: "pulse-test",
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

function daysAgoUtc(n: number, hour = 12): string {
  const now = new Date();
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return new Date(todayUtc - n * 86_400_000 + hour * 3_600_000).toISOString();
}

async function fixture() {
  const [magos] = await testDb.insert(schema.users)
    .values({ name: "magos", type: "human", instance_role: "owner" })
    .returning();
  const [claude] = await testDb.insert(schema.users)
    .values({ name: "claude", type: "agent" })
    .returning();
  const [poller] = await testDb.insert(schema.users)
    .values({ name: "external-ref-poller", type: "agent" })
    .returning();
  const [rules] = await testDb.insert(schema.users)
    .values({ name: "rules-engine", type: "agent" })
    .returning();
  const [active] = await testDb.insert(schema.projects)
    .values({ key: "ACT", name: "Active project" })
    .returning();
  const [quiet] = await testDb.insert(schema.projects)
    .values({ key: "QUI", name: "Quiet project" })
    .returning();
  await testDb.insert(schema.projectCounters).values([
    { project_id: active!.id }, { project_id: quiet!.id },
  ]);
  return { magos: magos!, claude: claude!, poller: poller!, rules: rules!, active: active!, quiet: quiet! };
}

async function event(projectId: string, actorId: string | null, at: string) {
  await testDb.insert(schema.events).values({
    project_id: projectId,
    ticket_id: null,
    event_type: "ticket.updated",
    actor_id: actorId,
    payload: {},
    created_at: at,
  });
}

describe("SWY-136 activity pulse", () => {
  test("series is 14 UTC-day buckets oldest→newest; last_activity_at is all-time", async () => {
    const fx = await fixture();

    // Today: 2 events; 3 days ago: 1 event; 20 days ago (outside window): 1
    // event that must not appear in the series but is beaten by today's for
    // last_activity_at anyway. Add one ancient-only event on the quiet
    // project so its last_activity_at is non-null while its series is flat.
    await event(fx.active.id, fx.claude.id, daysAgoUtc(0));
    await event(fx.active.id, fx.claude.id, daysAgoUtc(0, 13));
    await event(fx.active.id, fx.magos.id, daysAgoUtc(3));
    await event(fx.active.id, fx.claude.id, daysAgoUtc(20));
    await event(fx.quiet.id, fx.magos.id, daysAgoUtc(20));

    const token = await mintToken(fx.magos.id, ["tickets:read"]);
    const res = await GET("/v1/stats/activity-pulse", token);
    expect(res.status).toBe(200);
    const data = await res.json() as {
      days: number;
      items: Array<{
        project: { key: string };
        last_activity_at: string | null;
        activity_series: number[];
        recent_actors: Array<{ name: string; type: string }>;
      }>;
    };

    expect(data.days).toBe(14);
    const act = data.items.find((i) => i.project.key === "ACT")!;
    expect(act.activity_series).toHaveLength(14);
    expect(act.activity_series[13]).toBe(2);  // today = last bucket
    expect(act.activity_series[10]).toBe(1);  // 3 days ago
    expect(act.activity_series.reduce((a, b) => a + b, 0)).toBe(3); // 20d-ago excluded
    expect(act.last_activity_at).not.toBeNull();

    const quiet = data.items.find((i) => i.project.key === "QUI")!;
    expect(quiet.activity_series.every((n) => n === 0)).toBe(true);
    expect(quiet.last_activity_at).not.toBeNull(); // all-time, not window-bound
    expect(quiet.recent_actors).toHaveLength(0);
  });

  test("recent actors: most-recent first, capped at 3, carries type", async () => {
    const fx = await fixture();
    await event(fx.active.id, fx.magos.id, daysAgoUtc(4));
    await event(fx.active.id, fx.rules.id, daysAgoUtc(3));
    await event(fx.active.id, fx.poller.id, daysAgoUtc(2));
    await event(fx.active.id, fx.claude.id, daysAgoUtc(1));
    await event(fx.active.id, null, daysAgoUtc(0)); // system — never listed

    const token = await mintToken(fx.magos.id, ["tickets:read"]);
    const res = await GET("/v1/stats/activity-pulse", token);
    const data = await res.json() as {
      items: Array<{ project: { key: string }; recent_actors: Array<{ name: string; type: string }> }>;
    };
    const act = data.items.find((i) => i.project.key === "ACT")!;

    expect(act.recent_actors).toHaveLength(3); // magos (oldest) dropped by the cap
    expect(act.recent_actors.map((a) => a.name)).toEqual([
      "claude", "external-ref-poller", "rules-engine",
    ]);
    expect(act.recent_actors[0]!.type).toBe("agent");
  });

  test("member scope: only visible projects listed", async () => {
    const fx = await fixture();
    await event(fx.active.id, fx.claude.id, daysAgoUtc(0));

    const [member] = await testDb.insert(schema.users)
      .values({ name: "member", type: "human", instance_role: "member" })
      .returning();
    await testDb.insert(schema.userProjects).values({
      user_id: member!.id, project_id: fx.quiet.id, role: "viewer",
    });

    const token = await mintToken(member!.id, ["tickets:read"]);
    const res = await GET("/v1/stats/activity-pulse", token);
    expect(res.status).toBe(200);
    const data = await res.json() as { items: Array<{ project: { key: string } }> };
    expect(data.items.map((i) => i.project.key)).toEqual(["QUI"]);
  });
});
