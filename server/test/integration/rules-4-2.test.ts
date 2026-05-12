// Phase 4.2 integration tests: scheduled rules. Drives the scheduler's
// tick logic directly via the _tickOnce export so tests don't have to
// sleep for the 60s timer.
//
//   DATABASE_URL_TEST=postgres://...:5432/switchyard_test \
//     bun --cwd server test test/integration/rules-4-2.test.ts

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { sql, eq } from "drizzle-orm";
import { closeTestDb, schema, testDb } from "../db.js";

process.env.DATABASE_URL = process.env.DATABASE_URL_TEST!;

const dispatcher = await import("../../src/lib/rules/dispatcher.js");
const scheduler = await import("../../src/lib/rules/scheduler.js");

afterAll(async () => {
  await scheduler.stopScheduler();
  await dispatcher.stopDispatcher(2_000);
  await closeTestDb();
});

beforeEach(async () => {
  await scheduler.stopScheduler();
  scheduler._resetForTesting();
  await dispatcher.stopDispatcher(2_000);
  dispatcher._resetForTesting();
  await testDb.execute(
    sql`TRUNCATE rule_firings, rules, webhook_deliveries, webhook_subscriptions,
        targets, events, ticket_labels, comments, attachments, tickets,
        project_counters, statuses, status_transitions, labels, projects,
        api_tokens, idempotency_keys, users RESTART IDENTITY CASCADE`
  );
});

async function seedCtx() {
  const [magos] = await testDb.insert(schema.users).values({ name: "magos", type: "human" }).returning();
  await testDb.insert(schema.users).values({ name: "rules-engine", type: "agent" });
  const [project] = await testDb.insert(schema.projects).values({ key: "SCH", name: "Sched test" }).returning();
  await testDb.insert(schema.projectCounters).values({ project_id: project!.id });
  const statuses = await testDb.insert(schema.statuses).values([
    { project_id: project!.id, category: "backlog", display_name: "Backlog", position: 0, is_default: true },
    { project_id: project!.id, category: "in_progress", display_name: "In Progress", position: 1 },
    { project_id: project!.id, category: "closed", display_name: "Closed", position: 2 },
  ]).returning();
  return {
    magos: magos!, project: project!,
    backlog: statuses.find((s) => s.category === "backlog")!,
    inProgress: statuses.find((s) => s.category === "in_progress")!,
  };
}

async function waitForFiring(predicate: (rows: any[]) => boolean, timeoutMs = 5_000): Promise<any[]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await testDb.select().from(schema.ruleFirings);
    if (predicate(rows)) return rows;
    await new Promise((r) => setTimeout(r, 100));
  }
  const rows = await testDb.select().from(schema.ruleFirings);
  throw new Error(`timed out; firings=${JSON.stringify(rows.map((r) => ({ status: r.status, last_error: r.last_error })))}`);
}

describe("4.2 scheduled rules", () => {
  test("tick fires once per matched ticket and advances last_fired_at", async () => {
    const { magos, project, backlog, inProgress } = await seedCtx();

    // 2 tickets in in_progress, 1 in backlog. Rule targets in_progress.
    const insertedTickets = await testDb.insert(schema.tickets).values([
      { project_id: project.id, number: 1, type: "task", title: "wip-1", status_id: inProgress.id, reporter_id: magos.id },
      { project_id: project.id, number: 2, type: "task", title: "wip-2", status_id: inProgress.id, reporter_id: magos.id },
      { project_id: project.id, number: 3, type: "task", title: "bl-1", status_id: backlog.id, reporter_id: magos.id },
    ]).returning();

    // Cron that matched "1 minute ago" so the next-fire-from-since is in
    // the past. Use a rule that was last fired well before "now".
    const [rule] = await testDb.insert(schema.rules).values({
      project_id: project.id,
      name: "weekly nudge",
      enabled: true,
      trigger_event_types: [],
      conditions: {},
      actions: [{ type: "add_label", label: "nudged" }],
      schedule_cron: "* * * * *", // every minute
      schedule_tz: "UTC",
      target_query: { status: "in_progress" },
      webhook_secret: "test-secret",
      // last_fired_at = 2 hours ago so the next tick fires immediately.
      last_fired_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    }).returning();

    const fired = await scheduler._tickOnce();
    expect(fired).toBe(1);

    // 2 firings — one per in_progress ticket. backlog ticket is not targeted.
    const firings = await testDb.select().from(schema.ruleFirings).where(eq(schema.ruleFirings.rule_id, rule!.id));
    expect(firings.length).toBe(2);
    const targetIds = new Set(firings.map((f) => f.ticket_id));
    expect(targetIds.has(insertedTickets[0]!.id)).toBe(true);
    expect(targetIds.has(insertedTickets[1]!.id)).toBe(true);
    expect(targetIds.has(insertedTickets[2]!.id)).toBe(false);

    // last_fired_at advanced.
    const [refreshed] = await testDb.select().from(schema.rules).where(eq(schema.rules.id, rule!.id));
    expect(new Date(refreshed!.last_fired_at!).getTime()).toBeGreaterThan(Date.now() - 60_000);

    // Now run the dispatcher and verify the actions execute.
    dispatcher.startDispatcher();
    await waitForFiring((rs) => rs.filter((r) => r.status === "succeeded").length === 2);

    // Both in_progress tickets should now carry the nudged label.
    const links = await testDb.select().from(schema.ticketLabels);
    expect(links.length).toBe(2);
  }, 20_000);

  test("scheduled rule with no matched tickets still advances cron cursor", async () => {
    const { project } = await seedCtx();

    const [rule] = await testDb.insert(schema.rules).values({
      project_id: project.id,
      name: "nudge in_progress (none exist)",
      enabled: true,
      trigger_event_types: [],
      conditions: {},
      actions: [{ type: "add_label", label: "x" }],
      schedule_cron: "* * * * *",
      schedule_tz: "UTC",
      target_query: { status: "in_progress" },
      webhook_secret: "test-secret",
      last_fired_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    }).returning();

    const fired = await scheduler._tickOnce();
    expect(fired).toBe(1); // tick advanced even with zero matches

    const firings = await testDb.select().from(schema.ruleFirings);
    expect(firings.length).toBe(0);

    const [refreshed] = await testDb.select().from(schema.rules).where(eq(schema.rules.id, rule!.id));
    expect(new Date(refreshed!.last_fired_at!).getTime()).toBeGreaterThan(Date.now() - 60_000);
  }, 10_000);

  test("disabled scheduled rule does not fire", async () => {
    const { magos, project, inProgress } = await seedCtx();
    await testDb.insert(schema.tickets).values({
      project_id: project.id, number: 1, type: "task", title: "t", status_id: inProgress.id, reporter_id: magos.id,
    });

    await testDb.insert(schema.rules).values({
      project_id: project.id,
      name: "disabled",
      enabled: false,
      trigger_event_types: [],
      conditions: {},
      actions: [{ type: "add_label", label: "x" }],
      schedule_cron: "* * * * *",
      target_query: { status: "in_progress" },
      webhook_secret: "test-secret",
      last_fired_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    });

    const fired = await scheduler._tickOnce();
    expect(fired).toBe(0);

    const firings = await testDb.select().from(schema.ruleFirings);
    expect(firings.length).toBe(0);
  }, 10_000);

  test("not-yet-due rule does not fire", async () => {
    const { magos, project, inProgress } = await seedCtx();
    await testDb.insert(schema.tickets).values({
      project_id: project.id, number: 1, type: "task", title: "t", status_id: inProgress.id, reporter_id: magos.id,
    });

    // last_fired_at = "just now"; cron "every minute" → next fire in ~60s.
    await testDb.insert(schema.rules).values({
      project_id: project.id,
      name: "not due",
      enabled: true,
      trigger_event_types: [],
      conditions: {},
      actions: [{ type: "add_label", label: "x" }],
      schedule_cron: "* * * * *",
      target_query: { status: "in_progress" },
      webhook_secret: "test-secret",
      last_fired_at: new Date().toISOString(),
    });

    const fired = await scheduler._tickOnce();
    expect(fired).toBe(0);
  }, 10_000);

  test("invalid cron expression doesn't crash the scheduler", async () => {
    const { project } = await seedCtx();

    await testDb.insert(schema.rules).values({
      project_id: project.id,
      name: "bogus cron",
      enabled: true,
      trigger_event_types: [],
      conditions: {},
      actions: [{ type: "add_label", label: "x" }],
      schedule_cron: "not a real cron",
      target_query: { status: "in_progress" },
      webhook_secret: "test-secret",
    });

    // Should swallow the error and return 0 (not throw).
    const fired = await scheduler._tickOnce();
    expect(fired).toBe(0);
  }, 10_000);
});
