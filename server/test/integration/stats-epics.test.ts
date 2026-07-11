// SWY-137 integration tests: epics-in-flight endpoint.
//
//   DATABASE_URL_TEST=postgres://...:5432/switchyard_test \
//     bun --cwd server test test/integration/stats-epics.test.ts
//
// Covers: progress aggregation (closed/total children), childless epics,
// closed epics excluded, driver + last_activity_at from the epic FAMILY
// (child events roll up), the in_progress-only stall rule, and member scope.

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
    name: "epics-test",
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

function hoursAgo(h: number): string {
  return new Date(Date.now() - h * 3_600_000).toISOString();
}

async function fixture() {
  const [magos] = await testDb.insert(schema.users)
    .values({ name: "magos", type: "human", instance_role: "owner" })
    .returning();
  const [claude] = await testDb.insert(schema.users)
    .values({ name: "claude", type: "agent" })
    .returning();
  const [project] = await testDb.insert(schema.projects)
    .values({ key: "EPX", name: "Epics test" })
    .returning();
  await testDb.insert(schema.projectCounters).values({ project_id: project!.id });
  const mk = async (category: "backlog" | "in_progress" | "closed", name: string, pos: number) => {
    const [s] = await testDb.insert(schema.statuses).values({
      project_id: project!.id, category, display_name: name,
      position: pos, is_default: category === "backlog",
    }).returning();
    return s!;
  };
  const backlog = await mk("backlog", "Backlog", 0);
  const inProgress = await mk("in_progress", "In Progress", 1);
  const closed = await mk("closed", "Closed", 2);
  return { magos: magos!, claude: claude!, project: project!, backlog, inProgress, closed };
}

type Fx = Awaited<ReturnType<typeof fixture>>;

let seq = 0;
async function makeTicket(
  fx: Fx,
  opts: { type?: "epic" | "task"; statusId: string; parentId?: string; resolution?: "done"; title?: string },
) {
  seq += 1;
  const [t] = await testDb.insert(schema.tickets).values({
    project_id: fx.project.id, number: seq, type: opts.type ?? "task",
    title: opts.title ?? `T-${seq}`, status_id: opts.statusId, reporter_id: fx.magos.id,
    parent_id: opts.parentId ?? null, resolution: opts.resolution ?? null,
  }).returning();
  return t!;
}

async function event(ticketId: string, actorId: string | null, at: string) {
  const fxProject = (await testDb.select().from(schema.projects))[0]!;
  await testDb.insert(schema.events).values({
    project_id: fxProject.id, ticket_id: ticketId,
    event_type: "ticket.updated", actor_id: actorId, payload: {}, created_at: at,
  });
}

describe("SWY-137 epics in flight", () => {
  test("progress from children; childless = 0; closed epics excluded", async () => {
    const fx = await fixture();
    const epic = await makeTicket(fx, { type: "epic", statusId: fx.inProgress.id });
    await makeTicket(fx, { statusId: fx.closed.id, parentId: epic.id, resolution: "done" });
    await makeTicket(fx, { statusId: fx.closed.id, parentId: epic.id, resolution: "done" });
    await makeTicket(fx, { statusId: fx.backlog.id, parentId: epic.id });
    const childless = await makeTicket(fx, { type: "epic", statusId: fx.backlog.id });
    await makeTicket(fx, { type: "epic", statusId: fx.closed.id, resolution: "done" }); // excluded

    const token = await mintToken(fx.magos.id, ["tickets:read"]);
    const res = await GET("/v1/stats/epics", token);
    expect(res.status).toBe(200);
    const data = await res.json() as {
      stall_after_days: number;
      items: Array<{
        key: string; progress_pct: number; children_total: number; children_closed: number;
      }>;
    };

    expect(data.items).toHaveLength(2);
    const main = data.items.find((i) => i.key === `EPX-${epic.number}`)!;
    expect(main.children_total).toBe(3);
    expect(main.children_closed).toBe(2);
    expect(main.progress_pct).toBe(67);
    const empty = data.items.find((i) => i.key === `EPX-${childless.number}`)!;
    expect(empty.progress_pct).toBe(0);
    expect(empty.children_total).toBe(0);
  });

  test("driver + last activity roll up from CHILD events; stall is in_progress-only", async () => {
    const fx = await fixture();
    // Epic A (in_progress): agent event on a CHILD 1h ago → driver claude, not stalled.
    const a = await makeTicket(fx, { type: "epic", statusId: fx.inProgress.id });
    const aChild = await makeTicket(fx, { statusId: fx.backlog.id, parentId: a.id });
    await event(aChild.id, fx.claude.id, hoursAgo(1));

    // Epic B (in_progress): last agent event 10 days ago → stalled; a HUMAN
    // event 1h ago updates driver/last_activity but does not un-stall it.
    const b = await makeTicket(fx, { type: "epic", statusId: fx.inProgress.id });
    await event(b.id, fx.claude.id, hoursAgo(240));
    await event(b.id, fx.magos.id, hoursAgo(1));

    // Epic C (backlog): no agent activity at all → never stalled.
    const c2 = await makeTicket(fx, { type: "epic", statusId: fx.backlog.id });
    await event(c2.id, fx.magos.id, hoursAgo(2));

    const token = await mintToken(fx.magos.id, ["tickets:read"]);
    const res = await GET("/v1/stats/epics", token);
    const data = await res.json() as {
      items: Array<{
        key: string; stalled: boolean;
        driver: { name: string; type: string } | null;
        last_activity_at: string | null;
      }>;
    };
    const byKey = new Map(data.items.map((i) => [i.key, i]));

    const ra = byKey.get(`EPX-${a.number}`)!;
    expect(ra.stalled).toBe(false);
    expect(ra.driver?.name).toBe("claude");
    expect(ra.driver?.type).toBe("agent");
    expect(ra.last_activity_at).not.toBeNull();

    const rb = byKey.get(`EPX-${b.number}`)!;
    expect(rb.stalled).toBe(true);
    expect(rb.driver?.name).toBe("magos"); // latest ANY-actor event wins the driver slot

    const rc = byKey.get(`EPX-${c2.number}`)!;
    expect(rc.stalled).toBe(false);
  });

  test("SWY-162: ordered by recent activity; null-activity sinks, title tie-break", async () => {
    const fx = await fixture();
    // Three active epics with distinct last-activity times (activity rolls up
    // from a child event so the FAMILY window is exercised, not just the epic).
    const recent = await makeTicket(fx, { type: "epic", statusId: fx.inProgress.id, title: "recent" });
    const rChild = await makeTicket(fx, { statusId: fx.backlog.id, parentId: recent.id });
    await event(rChild.id, fx.claude.id, hoursAgo(1));

    const middle = await makeTicket(fx, { type: "epic", statusId: fx.inProgress.id, title: "middle" });
    await event(middle.id, fx.claude.id, hoursAgo(5));

    const oldest = await makeTicket(fx, { type: "epic", statusId: fx.inProgress.id, title: "oldest" });
    await event(oldest.id, fx.claude.id, hoursAgo(10));

    // Two never-touched epics: both sink below the active ones and order
    // case-insensitively by title ("Apple" before "zebra").
    const zebra = await makeTicket(fx, { type: "epic", statusId: fx.backlog.id, title: "zebra" });
    const apple = await makeTicket(fx, { type: "epic", statusId: fx.backlog.id, title: "Apple" });

    const token = await mintToken(fx.magos.id, ["tickets:read"]);
    const res = await GET("/v1/stats/epics", token);
    expect(res.status).toBe(200);
    const data = await res.json() as { items: Array<{ key: string; last_activity_at: string | null }> };

    expect(data.items.map((i) => i.key)).toEqual([
      `EPX-${recent.number}`,
      `EPX-${middle.number}`,
      `EPX-${oldest.number}`,
      `EPX-${apple.number}`, // null activity, alphabetically first (case-insensitive)
      `EPX-${zebra.number}`, // null activity, alphabetically last
    ]);
    expect(data.items.at(-1)!.last_activity_at).toBeNull();
    expect(data.items.at(-2)!.last_activity_at).toBeNull();
  });

  test("member scope: epics from invisible projects are excluded", async () => {
    const fx = await fixture();
    await makeTicket(fx, { type: "epic", statusId: fx.inProgress.id });

    const [member] = await testDb.insert(schema.users)
      .values({ name: "member", type: "human", instance_role: "member" })
      .returning();
    const token = await mintToken(member!.id, ["tickets:read"]);
    const res = await GET("/v1/stats/epics", token);
    expect(res.status).toBe(200);
    const data = await res.json() as { items: unknown[] };
    expect(data.items).toHaveLength(0);
  });
});
