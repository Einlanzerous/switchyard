// Phase 4.1 integration tests: the 4 new actions, global rules across
// projects, and the per-rule rate limit.
//
//   DATABASE_URL_TEST=postgres://...:5432/switchyard_test \
//     bun --cwd server test test/integration/rules-4-1.test.ts

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { sql, eq } from "drizzle-orm";
import { closeTestDb, schema, testDb } from "../db.js";
import { writeEvent } from "../../src/lib/events.js";

process.env.DATABASE_URL = process.env.DATABASE_URL_TEST!;
process.env.RULE_RATE_LIMIT_PER_HOUR = "3"; // keep the rate-limit test tight
const ORIGINAL_N8N = process.env.N8N_BASE_URL;

const { startDispatcher, stopDispatcher, _resetForTesting } =
  await import("../../src/lib/rules/dispatcher.js");

afterAll(async () => {
  await stopDispatcher(2_000);
  await closeTestDb();
  if (ORIGINAL_N8N === undefined) delete process.env.N8N_BASE_URL;
  else process.env.N8N_BASE_URL = ORIGINAL_N8N;
});

beforeEach(async () => {
  // Stop + reset the dispatcher so the next startDispatcher() picks up
  // the rules-engine row from the freshly-seeded user table.
  await stopDispatcher(2_000);
  _resetForTesting();
  await testDb.execute(
    sql`TRUNCATE rule_firings, rules, webhook_deliveries, webhook_subscriptions,
        targets, events, ticket_labels, comments, attachments, tickets,
        project_counters, statuses, status_transitions, labels, projects,
        api_tokens, idempotency_keys, users RESTART IDENTITY CASCADE`
  );
});

async function seedCtx(opts: { projectKey?: string } = {}) {
  const [magos] = await testDb.insert(schema.users).values({ name: "magos", type: "human" }).returning();
  const [rulesEngine] = await testDb.insert(schema.users).values({ name: "rules-engine", type: "agent" }).returning();
  const [project] = await testDb.insert(schema.projects)
    .values({ key: opts.projectKey ?? "AAA", name: "Test project" })
    .returning();
  await testDb.insert(schema.projectCounters).values({ project_id: project!.id });
  const statuses = await testDb.insert(schema.statuses).values([
    { project_id: project!.id, category: "backlog", display_name: "Backlog", position: 0, is_default: true },
    { project_id: project!.id, category: "in_progress", display_name: "In Progress", position: 1 },
    { project_id: project!.id, category: "closed", display_name: "Closed", position: 2 },
  ]).returning();
  return {
    magos: magos!, rulesEngine: rulesEngine!, project: project!,
    backlog: statuses.find((s) => s.category === "backlog")!,
    inProgress: statuses.find((s) => s.category === "in_progress")!,
    closed: statuses.find((s) => s.category === "closed")!,
  };
}

async function emitTicketCreated(opts: {
  ticket: typeof schema.tickets.$inferSelect;
  actor: typeof schema.users.$inferSelect;
  project: typeof schema.projects.$inferSelect;
  status: typeof schema.statuses.$inferSelect;
}) {
  const { ticket, actor, project, status } = opts;
  await testDb.transaction(async (tx) => {
    await writeEvent(tx as any, {
      event_type: "ticket.created",
      actor: { id: actor.id, name: actor.name, icon: actor.icon, type: actor.type },
      ticket: {
        id: ticket.id, key: `${project.key}-${ticket.number}`, number: ticket.number,
        project: { id: project.id, key: project.key, name: project.name, color: project.color },
        type: ticket.type as any, title: ticket.title,
        status: { id: status.id, category: status.category as any, display_name: status.display_name },
        resolution: null, priority: null, parent_id: null,
        assignee: null,
        reporter: { id: actor.id, name: actor.name, icon: actor.icon, type: actor.type },
        due_date: null, labels: [], position: ticket.position,
        created_at: ticket.created_at, updated_at: ticket.updated_at, deleted_at: null,
      },
      project_id: project.id,
    });
  });
}

async function waitForFiring(predicate: (rows: any[]) => boolean, timeoutMs = 5_000): Promise<any[]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await testDb.select().from(schema.ruleFirings);
    if (predicate(rows)) return rows;
    await new Promise((r) => setTimeout(r, 100));
  }
  const rows = await testDb.select().from(schema.ruleFirings);
  throw new Error(`timed out; final firings: ${JSON.stringify(rows.map((r) => ({ status: r.status, last_error: r.last_error })))}`);
}

describe("4.1 actions", () => {
  test("assign action resolves by name + emits ticket.assigned", async () => {
    const { magos, project, backlog } = await seedCtx();

    await testDb.insert(schema.rules).values({
      project_id: project.id, name: "auto-assign", enabled: true,
      trigger_event_types: ["ticket.created"], conditions: {},
      actions: [{ type: "assign", user: "magos" }],
      webhook_secret: "test-secret",
    });

    const [ticket] = await testDb.insert(schema.tickets).values({
      project_id: project.id, number: 1, type: "task", title: "t",
      status_id: backlog.id, reporter_id: magos.id,
    }).returning();

    await emitTicketCreated({ ticket: ticket!, actor: magos, project, status: backlog });
    startDispatcher();
    await waitForFiring((rows) => rows.some((r) => r.status === "succeeded"));

    const [refreshed] = await testDb.select().from(schema.tickets).where(eq(schema.tickets.id, ticket!.id));
    expect(refreshed!.assignee_id).toBe(magos.id);

    const assigned = await testDb.select().from(schema.events).where(eq(schema.events.event_type, "ticket.assigned"));
    expect(assigned.length).toBeGreaterThan(0);
  }, 15_000);

  test("move_status action transitions through transitions table + emits closed", async () => {
    const { magos, project, backlog, closed } = await seedCtx();

    // Whitelist: backlog → closed
    await testDb.insert(schema.statusTransitions).values({
      project_id: project.id, from_status_id: backlog.id, to_status_id: closed.id,
    });

    await testDb.insert(schema.rules).values({
      project_id: project.id, name: "auto-close", enabled: true,
      trigger_event_types: ["ticket.created"], conditions: {},
      actions: [{ type: "move_status", to_category: "closed", resolution: "done" }],
      webhook_secret: "test-secret",
    });

    const [ticket] = await testDb.insert(schema.tickets).values({
      project_id: project.id, number: 1, type: "task", title: "t",
      status_id: backlog.id, reporter_id: magos.id,
    }).returning();

    await emitTicketCreated({ ticket: ticket!, actor: magos, project, status: backlog });
    startDispatcher();
    await waitForFiring((rows) => rows.some((r) => r.status === "succeeded"));

    const [refreshed] = await testDb.select().from(schema.tickets).where(eq(schema.tickets.id, ticket!.id));
    expect(refreshed!.status_id).toBe(closed.id);
    expect(refreshed!.resolution).toBe("done");

    const closedEvents = await testDb.select().from(schema.events).where(eq(schema.events.event_type, "ticket.closed"));
    expect(closedEvents.length).toBeGreaterThan(0);
  }, 15_000);

  test("move_status rejects when no transition is whitelisted", async () => {
    const { magos, project, backlog, inProgress } = await seedCtx();

    // Whitelist exists but only backlog → in_progress, not → closed.
    await testDb.insert(schema.statusTransitions).values({
      project_id: project.id, from_status_id: backlog.id, to_status_id: inProgress.id,
    });

    await testDb.insert(schema.rules).values({
      project_id: project.id, name: "illegal-close", enabled: true,
      trigger_event_types: ["ticket.created"], conditions: {},
      actions: [{ type: "move_status", to_category: "closed", resolution: "done" }],
      webhook_secret: "test-secret",
    });

    const [ticket] = await testDb.insert(schema.tickets).values({
      project_id: project.id, number: 1, type: "task", title: "t",
      status_id: backlog.id, reporter_id: magos.id,
    }).returning();

    await emitTicketCreated({ ticket: ticket!, actor: magos, project, status: backlog });
    startDispatcher();
    const rows = await waitForFiring((rs) => rs.some((r) => r.status === "failed"));
    const failed = rows.find((r) => r.status === "failed")!;
    expect(failed.last_error).toContain("not allowed");

    const [refreshed] = await testDb.select().from(schema.tickets).where(eq(schema.tickets.id, ticket!.id));
    expect(refreshed!.status_id).toBe(backlog.id); // unchanged
  }, 15_000);

  test("fire_webhook posts HMAC-signed envelope and succeeds on 200", async () => {
    const { magos, project, backlog } = await seedCtx();

    let received: { body: string; sig: string | null } | null = null;
    const mock = Bun.serve({
      port: 0,
      async fetch(req) {
        received = {
          body: await req.text(),
          sig: req.headers.get("x-switchyard-signature"),
        };
        return new Response("ok", { status: 200 });
      },
    });
    const mockUrl = `http://127.0.0.1:${mock.port}/hook`;

    try {
      await testDb.insert(schema.rules).values({
        project_id: project.id, name: "ping-mock", enabled: true,
        trigger_event_types: ["ticket.created"], conditions: {},
        actions: [{ type: "fire_webhook", url: mockUrl, method: "POST" }],
        webhook_secret: "test-secret-1234567890",
      });

      const [ticket] = await testDb.insert(schema.tickets).values({
        project_id: project.id, number: 1, type: "task", title: "t",
        status_id: backlog.id, reporter_id: magos.id,
      }).returning();

      await emitTicketCreated({ ticket: ticket!, actor: magos, project, status: backlog });
      startDispatcher();
      await waitForFiring((rs) => rs.some((r) => r.status === "succeeded"));

      expect(received).not.toBeNull();
      expect(received!.sig).toMatch(/^sha256=[0-9a-f]{64}$/);
      const parsed = JSON.parse(received!.body);
      expect(parsed.event).toBe("ticket.created");
      expect(parsed.ticket?.key).toBe(`${project.key}-1`);
    } finally {
      mock.stop(true);
    }
  }, 15_000);

  test("call_n8n fails with clear error when N8N_BASE_URL is unset", async () => {
    delete process.env.N8N_BASE_URL;
    const { magos, project, backlog } = await seedCtx();

    await testDb.insert(schema.rules).values({
      project_id: project.id, name: "n8n-unset", enabled: true,
      trigger_event_types: ["ticket.created"], conditions: {},
      actions: [{ type: "call_n8n", workflow: "/webhook/test" }],
      webhook_secret: "test-secret",
    });

    const [ticket] = await testDb.insert(schema.tickets).values({
      project_id: project.id, number: 1, type: "task", title: "t",
      status_id: backlog.id, reporter_id: magos.id,
    }).returning();

    await emitTicketCreated({ ticket: ticket!, actor: magos, project, status: backlog });
    startDispatcher();
    const rows = await waitForFiring((rs) => rs.some((r) => r.status === "failed"));
    const failed = rows.find((r) => r.status === "failed")!;
    expect(failed.last_error).toContain("N8N_BASE_URL");
  }, 15_000);
});

describe("4.1 cross-project + rate limit", () => {
  test("global rule (project_id = NULL) fires on events in any project", async () => {
    const { magos, project: a, backlog: bl_a } = await seedCtx({ projectKey: "AAA" });

    const [b] = await testDb.insert(schema.projects).values({ key: "BBB", name: "B" }).returning();
    await testDb.insert(schema.projectCounters).values({ project_id: b!.id });
    const [bl_b] = await testDb.insert(schema.statuses).values({
      project_id: b!.id, category: "backlog", display_name: "Backlog", position: 0, is_default: true,
    }).returning();

    // Global rule: project_id IS NULL → applies to both projects.
    await testDb.insert(schema.rules).values({
      project_id: null,
      name: "global-label", enabled: true,
      trigger_event_types: ["ticket.created"], conditions: {},
      actions: [{ type: "add_label", label: "global-tag" }],
      webhook_secret: "test-secret",
    });

    const [ta] = await testDb.insert(schema.tickets).values({
      project_id: a.id, number: 1, type: "task", title: "in-a",
      status_id: bl_a.id, reporter_id: magos.id,
    }).returning();
    const [tb] = await testDb.insert(schema.tickets).values({
      project_id: b!.id, number: 1, type: "task", title: "in-b",
      status_id: bl_b!.id, reporter_id: magos.id,
    }).returning();

    await emitTicketCreated({ ticket: ta!, actor: magos, project: a, status: bl_a });
    await emitTicketCreated({ ticket: tb!, actor: magos, project: b!, status: bl_b! });

    startDispatcher();
    await waitForFiring((rs) => rs.filter((r) => r.status === "succeeded").length >= 2);

    // Both tickets carry the global-tag label.
    const linksA = await testDb.select().from(schema.ticketLabels).where(eq(schema.ticketLabels.ticket_id, ta!.id));
    const linksB = await testDb.select().from(schema.ticketLabels).where(eq(schema.ticketLabels.ticket_id, tb!.id));
    expect(linksA.length).toBe(1);
    expect(linksB.length).toBe(1);
  }, 20_000);

  test("rate limit skips firings beyond the per-hour cap", async () => {
    // RULE_RATE_LIMIT_PER_HOUR is set to 3 at the top of the file.
    const { magos, project, backlog } = await seedCtx();

    const [rule] = await testDb.insert(schema.rules).values({
      project_id: project.id, name: "spammy", enabled: true,
      trigger_event_types: ["ticket.created"], conditions: {},
      actions: [{ type: "add_label", label: "x" }],
      webhook_secret: "test-secret",
    }).returning();

    // Fire 5 ticket.created events. Limit is 3 → expect 3 succeeded + 2 skipped.
    for (let i = 1; i <= 5; i++) {
      const [t] = await testDb.insert(schema.tickets).values({
        project_id: project.id, number: i, type: "task", title: `t${i}`,
        status_id: backlog.id, reporter_id: magos.id,
      }).returning();
      await emitTicketCreated({ ticket: t!, actor: magos, project, status: backlog });
    }

    startDispatcher();
    await waitForFiring((rs) => rs.filter((r) => r.rule_id === rule!.id).length === 5
      && rs.filter((r) => r.rule_id === rule!.id && (r.status === "succeeded" || r.status === "skipped")).length === 5);

    const firings = await testDb.select().from(schema.ruleFirings)
      .where(eq(schema.ruleFirings.rule_id, rule!.id));
    const succeeded = firings.filter((f) => f.status === "succeeded").length;
    const skipped = firings.filter((f) => f.status === "skipped").length;
    expect(succeeded).toBe(3);
    expect(skipped).toBe(2);
    expect(firings.filter((f) => f.last_error === "rate_limited").length).toBe(2);
  }, 20_000);
});
