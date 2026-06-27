// SWY-118 integration tests: the 3-level ticket hierarchy
// (epic → {task,bug,spike} → subtask).
//
//   DATABASE_URL_TEST=postgres://...:5432/switchyard_test \
//     bun --cwd server test test/integration/ticket-hierarchy.test.ts
//
// Covers: the enforce_ticket_hierarchy() trigger (positive + negative),
// direct-children-only rollup (Decision 3), and the rules-engine
// interactions — a subtask auto-closes via the type-agnostic move_status
// action, and the epic-only close-guard lets a parent task close while a
// subtask is still open.

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { sql, and, eq, isNull } from "drizzle-orm";
import { closeTestDb, schema, testDb } from "../db.js";
import { writeEvent } from "../../src/lib/events.js";

process.env.DATABASE_URL = process.env.DATABASE_URL_TEST!;

const { startDispatcher, stopDispatcher, _resetForTesting } =
  await import("../../src/lib/rules/dispatcher.js");

afterAll(async () => {
  await stopDispatcher(2_000);
  await closeTestDb();
});

beforeEach(async () => {
  await stopDispatcher(2_000);
  _resetForTesting();
  await testDb.execute(
    sql`TRUNCATE rule_firings, rules, ticket_links, webhook_deliveries,
        webhook_subscriptions, targets, events, ticket_labels, comments,
        attachments, tickets, project_counters, statuses, status_transitions,
        labels, projects, api_tokens, idempotency_keys, users
        RESTART IDENTITY CASCADE`
  );
});

type Ctx = {
  magos: typeof schema.users.$inferSelect;
  rulesEngine: typeof schema.users.$inferSelect;
  project: typeof schema.projects.$inferSelect;
  backlog: typeof schema.statuses.$inferSelect;
  closed: typeof schema.statuses.$inferSelect;
};

async function seedCtx(): Promise<Ctx> {
  const [magos] = await testDb.insert(schema.users).values({ name: "magos", type: "human" }).returning();
  const [rulesEngine] = await testDb.insert(schema.users).values({ name: "rules-engine", type: "agent" }).returning();
  const [project] = await testDb.insert(schema.projects).values({ key: "HIER", name: "Hierarchy test" }).returning();
  await testDb.insert(schema.projectCounters).values({ project_id: project!.id });
  const statuses = await testDb.insert(schema.statuses).values([
    { project_id: project!.id, category: "backlog", display_name: "Backlog", position: 0, is_default: true },
    { project_id: project!.id, category: "closed", display_name: "Closed", position: 1 },
  ]).returning();
  const backlog = statuses.find((s) => s.category === "backlog")!;
  const closed = statuses.find((s) => s.category === "closed")!;
  // Whitelist backlog → closed so the move_status action can land.
  await testDb.insert(schema.statusTransitions).values({
    project_id: project!.id, from_status_id: backlog.id, to_status_id: closed.id,
  });
  return { magos: magos!, rulesEngine: rulesEngine!, project: project!, backlog, closed };
}

let nextNumber = 1;
async function insertTicket(
  ctx: Ctx,
  opts: { type: "epic" | "task" | "bug" | "spike" | "subtask"; parentId?: string | null; statusId?: string },
): Promise<typeof schema.tickets.$inferSelect> {
  const [t] = await testDb.insert(schema.tickets).values({
    project_id: ctx.project.id,
    number: nextNumber++,
    type: opts.type,
    title: `${opts.type}-${nextNumber}`,
    status_id: opts.statusId ?? ctx.backlog.id,
    reporter_id: ctx.magos.id,
    parent_id: opts.parentId ?? null,
  }).returning();
  return t!;
}

async function expectInsertRejected(
  ctx: Ctx,
  opts: { type: "epic" | "task" | "bug" | "spike" | "subtask"; parentId?: string | null },
  messageMatch: RegExp,
): Promise<void> {
  let err: unknown;
  try {
    await insertTicket(ctx, opts);
  } catch (e) {
    err = e;
  }
  expect(err).toBeDefined();
  expect(String(err)).toMatch(messageMatch);
}

async function emitTicketCreated(ctx: Ctx, ticket: typeof schema.tickets.$inferSelect) {
  await testDb.transaction(async (tx) => {
    await writeEvent(tx as any, {
      event_type: "ticket.created",
      actor: { id: ctx.magos.id, name: ctx.magos.name, icon: ctx.magos.icon, type: ctx.magos.type },
      ticket: {
        id: ticket.id, key: `${ctx.project.key}-${ticket.number}`, number: ticket.number,
        project: { id: ctx.project.id, key: ctx.project.key, name: ctx.project.name, color: ctx.project.color },
        type: ticket.type as any, title: ticket.title,
        status: { id: ctx.backlog.id, category: "backlog", display_name: ctx.backlog.display_name },
        resolution: null, priority: null, parent_id: ticket.parent_id,
        assignee: null,
        reporter: { id: ctx.magos.id, name: ctx.magos.name, icon: ctx.magos.icon, type: ctx.magos.type },
        due_date: null, labels: [], position: ticket.position,
        created_at: ticket.created_at, updated_at: ticket.updated_at, deleted_at: null,
      },
      project_id: ctx.project.id,
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

describe("SWY-118 hierarchy trigger — positive", () => {
  test("a subtask can hang off a task, a bug, and a spike", async () => {
    const ctx = await seedCtx();
    for (const parentType of ["task", "bug", "spike"] as const) {
      const parent = await insertTicket(ctx, { type: parentType });
      const sub = await insertTicket(ctx, { type: "subtask", parentId: parent.id });
      expect(sub.parent_id).toBe(parent.id);
    }
  });

  test("the full epic → task → subtask chain inserts cleanly", async () => {
    const ctx = await seedCtx();
    const epic = await insertTicket(ctx, { type: "epic" });
    const task = await insertTicket(ctx, { type: "task", parentId: epic.id });
    const sub = await insertTicket(ctx, { type: "subtask", parentId: task.id });
    expect(task.parent_id).toBe(epic.id);
    expect(sub.parent_id).toBe(task.id);
  });
});

describe("SWY-118 hierarchy trigger — negative", () => {
  test("a subtask under an epic is rejected", async () => {
    const ctx = await seedCtx();
    const epic = await insertTicket(ctx, { type: "epic" });
    await expectInsertRejected(ctx, { type: "subtask", parentId: epic.id }, /subtask parent must be a task, bug, or spike/);
  });

  test("a subtask under another subtask is rejected (no subtask-of-subtask)", async () => {
    const ctx = await seedCtx();
    const task = await insertTicket(ctx, { type: "task" });
    const sub = await insertTicket(ctx, { type: "subtask", parentId: task.id });
    await expectInsertRejected(ctx, { type: "subtask", parentId: sub.id }, /subtask parent must be a task, bug, or spike/);
  });

  test("a subtask with no parent is rejected", async () => {
    const ctx = await seedCtx();
    await expectInsertRejected(ctx, { type: "subtask", parentId: null }, /subtasks must have a parent/);
  });

  test("a subtask may not be used as a parent for a task", async () => {
    const ctx = await seedCtx();
    const task = await insertTicket(ctx, { type: "task" });
    const sub = await insertTicket(ctx, { type: "subtask", parentId: task.id });
    // A task parented under a subtask: child is task → parent must be epic.
    await expectInsertRejected(ctx, { type: "task", parentId: sub.id }, /parent ticket must be type=epic/);
  });
});

describe("SWY-118 rollup — direct children only (Decision 3)", () => {
  test("an epic's children are its tasks only; grandchild subtasks roll up to the task", async () => {
    const ctx = await seedCtx();
    const epic = await insertTicket(ctx, { type: "epic" });
    const task = await insertTicket(ctx, { type: "task", parentId: epic.id });
    await insertTicket(ctx, { type: "subtask", parentId: task.id });
    await insertTicket(ctx, { type: "subtask", parentId: task.id });

    const epicChildren = await testDb.select().from(schema.tickets)
      .where(and(eq(schema.tickets.parent_id, epic.id), isNull(schema.tickets.deleted_at)));
    expect(epicChildren).toHaveLength(1);
    expect(epicChildren[0]!.id).toBe(task.id);

    const taskChildren = await testDb.select().from(schema.tickets)
      .where(and(eq(schema.tickets.parent_id, task.id), isNull(schema.tickets.deleted_at)));
    expect(taskChildren).toHaveLength(2);
  });
});

describe("SWY-118 rules engine — auto-close + epic-only close guard", () => {
  test("a subtask auto-closes via the type-agnostic move_status action", async () => {
    const ctx = await seedCtx();
    const task = await insertTicket(ctx, { type: "task" });
    const sub = await insertTicket(ctx, { type: "subtask", parentId: task.id });

    await testDb.insert(schema.rules).values({
      project_id: ctx.project.id, name: "auto-close-subtask", enabled: true,
      trigger_event_types: ["ticket.created"], conditions: {},
      actions: [{ type: "move_status", to_category: "closed", resolution: "done" }],
      webhook_secret: "test-secret",
    });

    await emitTicketCreated(ctx, sub);
    startDispatcher();
    await waitForFiring((rows) => rows.some((r) => r.status === "succeeded"));

    const [refreshed] = await testDb.select().from(schema.tickets).where(eq(schema.tickets.id, sub.id));
    expect(refreshed!.status_id).toBe(ctx.closed.id);
    expect(refreshed!.resolution).toBe("done");
  }, 15_000);

  test("a parent task closes via move_status even with an open subtask (guard stays epic-only)", async () => {
    const ctx = await seedCtx();
    const task = await insertTicket(ctx, { type: "task" });
    // An open subtask under the task — must NOT block the task's auto-close.
    await insertTicket(ctx, { type: "subtask", parentId: task.id });

    await testDb.insert(schema.rules).values({
      project_id: ctx.project.id, name: "auto-close-parent-task", enabled: true,
      trigger_event_types: ["ticket.created"], conditions: {},
      actions: [{ type: "move_status", to_category: "closed", resolution: "done" }],
      webhook_secret: "test-secret",
    });

    // Emit only for the parent task so only its firing runs.
    await emitTicketCreated(ctx, task);
    startDispatcher();
    await waitForFiring((rows) => rows.some((r) => r.status === "succeeded"));

    const [refreshed] = await testDb.select().from(schema.tickets).where(eq(schema.tickets.id, task.id));
    expect(refreshed!.status_id).toBe(ctx.closed.id);
    expect(refreshed!.resolution).toBe("done");
    expect(
      (await testDb.select().from(schema.ruleFirings)).every((r) => r.status !== "failed"),
    ).toBe(true);
  }, 15_000);
});
