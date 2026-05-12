// End-to-end test of the rules engine.
//
// Strategy:
//   1. Truncate everything; seed a project + statuses + rules-engine user + magos.
//   2. Insert a Rule that triggers on ticket.created, with an `add_label` action.
//   3. Insert a ticket directly and call writeEvent("ticket.created").
//   4. Start the rules dispatcher.
//   5. Assert the firing row succeeds, the label is attached, and the
//      rule-authored ticket.updated event has actor = rules-engine.
//
// Run with:
//   DATABASE_URL_TEST=postgres://...:5432/switchyard_test \
//     bun --cwd server test test/integration/rules.test.ts

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { sql, eq, and } from "drizzle-orm";
import { closeTestDb, schema, testDb } from "../db.js";
import { writeEvent } from "../../src/lib/events.js";

process.env.DATABASE_URL = process.env.DATABASE_URL_TEST!;

const { startDispatcher, stopDispatcher, _resetForTesting } =
  await import("../../src/lib/rules/dispatcher.js");

beforeAll(() => {});
afterAll(async () => {
  await stopDispatcher(2_000);
  await closeTestDb();
});

beforeEach(async () => {
  // See rules-4-1.test.ts for the rationale: stop + reset the dispatcher
  // so the next startDispatcher() rebootstraps with the freshly-seeded
  // rules-engine row (TRUNCATE below wipes it).
  await stopDispatcher(2_000);
  _resetForTesting();
  await testDb.execute(
    sql`TRUNCATE rule_firings, rules, webhook_deliveries, webhook_subscriptions,
        targets, events, ticket_labels, comments, attachments, tickets,
        project_counters, statuses, status_transitions, labels, projects,
        api_tokens, idempotency_keys, users RESTART IDENTITY CASCADE`
  );
});

async function seedMinimalCtx() {
  const [magos] = await testDb.insert(schema.users)
    .values({ name: "magos", type: "human" })
    .returning();
  const [rulesEngine] = await testDb.insert(schema.users)
    .values({ name: "rules-engine", type: "agent" })
    .returning();
  const [project] = await testDb.insert(schema.projects)
    .values({ key: "RUL", name: "Rules test" })
    .returning();
  await testDb.insert(schema.projectCounters).values({ project_id: project!.id });
  const [backlog] = await testDb.insert(schema.statuses).values({
    project_id: project!.id, category: "backlog", display_name: "Backlog",
    position: 0, is_default: true,
  }).returning();
  return { magos: magos!, rulesEngine: rulesEngine!, project: project!, backlog: backlog! };
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

async function waitForFiring(predicate: (rows: any[]) => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await testDb.select().from(schema.ruleFirings);
    if (predicate(rows)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("timed out waiting for rule firing");
}

describe("rule dispatcher end-to-end", () => {
  test("fires on ticket.created, runs add_label, writes audit event with rules-engine actor", async () => {
    const { magos, rulesEngine, project, backlog } = await seedMinimalCtx();

    // Rule: when a high-priority ticket is created in this project, add `auto-triage`.
    await testDb.insert(schema.rules).values({
      project_id: project.id,
      name: "auto-triage on creation",
      enabled: true,
      trigger_event_types: ["ticket.created"],
      conditions: {},
      actions: [{ type: "add_label", label: "auto-triage" }],
    });

    const [ticket] = await testDb.insert(schema.tickets).values({
      project_id: project.id, number: 1, type: "task",
      title: "tester", status_id: backlog.id, reporter_id: magos.id,
    }).returning();

    await emitTicketCreated({ ticket: ticket!, actor: magos, project, status: backlog });

    startDispatcher();

    await waitForFiring((rows) => rows.some((r) => r.status === "succeeded"));

    // Label is attached.
    const [link] = await testDb.select().from(schema.ticketLabels)
      .where(eq(schema.ticketLabels.ticket_id, ticket!.id));
    expect(link).toBeDefined();

    const [label] = await testDb.select().from(schema.labels)
      .where(eq(schema.labels.name, "auto-triage"));
    expect(label).toBeDefined();

    // The rule wrote a ticket.updated event with actor = rules-engine.
    const ruleAuthoredEvents = await testDb.select().from(schema.events)
      .where(and(eq(schema.events.event_type, "ticket.updated"), eq(schema.events.actor_id, rulesEngine.id)));
    expect(ruleAuthoredEvents.length).toBeGreaterThan(0);

    // No infinite loop: the rule should NOT have fired on its own ticket.updated.
    // Only the original ticket.created firing exists.
    const firings = await testDb.select().from(schema.ruleFirings);
    expect(firings.length).toBe(1);
  }, 15_000);

  test("skipped when conditions are false", async () => {
    const { magos, project, backlog } = await seedMinimalCtx();

    await testDb.insert(schema.rules).values({
      project_id: project.id,
      name: "only-on-high",
      enabled: true,
      trigger_event_types: ["ticket.created"],
      // Will not match — ticket.priority is null in our minimal seed.
      conditions: { all: [{ field: "ticket.priority", op: "eq", value: "high" }] },
      actions: [{ type: "add_label", label: "high-priority" }],
    });

    const [ticket] = await testDb.insert(schema.tickets).values({
      project_id: project.id, number: 1, type: "task",
      title: "low-pri tester", status_id: backlog.id, reporter_id: magos.id,
    }).returning();

    await emitTicketCreated({ ticket: ticket!, actor: magos, project, status: backlog });

    startDispatcher();

    await waitForFiring((rows) => rows.some((r) => r.status === "skipped"));

    const links = await testDb.select().from(schema.ticketLabels)
      .where(eq(schema.ticketLabels.ticket_id, ticket!.id));
    expect(links.length).toBe(0);
  }, 15_000);

  test("does not fire when rule is disabled", async () => {
    const { magos, project, backlog } = await seedMinimalCtx();

    await testDb.insert(schema.rules).values({
      project_id: project.id,
      name: "disabled rule",
      enabled: false,
      trigger_event_types: ["ticket.created"],
      conditions: {},
      actions: [{ type: "add_label", label: "should-not-attach" }],
    });

    const [ticket] = await testDb.insert(schema.tickets).values({
      project_id: project.id, number: 1, type: "task",
      title: "disabled rule tester", status_id: backlog.id, reporter_id: magos.id,
    }).returning();

    await emitTicketCreated({ ticket: ticket!, actor: magos, project, status: backlog });

    // No fan-out: disabled rules don't get rule_firings rows.
    await new Promise((r) => setTimeout(r, 500));
    const firings = await testDb.select().from(schema.ruleFirings);
    expect(firings.length).toBe(0);
  }, 10_000);
});
