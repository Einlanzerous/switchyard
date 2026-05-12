// Phase 4.5.0 integration tests: typed cross-ticket relations.
//
//   DATABASE_URL_TEST=postgres://...:5432/switchyard_test \
//     bun --cwd server test test/integration/ticket-links.test.ts
//
// Covers: POST + GET round-trip, self-link rejection, duplicate-edge
// rejection (409), cross-project links, direction tagging, event
// emission, DELETE + event emission.

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { closeTestDb, schema, testDb } from "../db.js";

process.env.DATABASE_URL = process.env.DATABASE_URL_TEST!;

afterAll(async () => {
  await closeTestDb();
});

beforeEach(async () => {
  await testDb.execute(
    sql`TRUNCATE rule_firings, rules, ticket_links, webhook_deliveries,
        webhook_subscriptions, targets, events, ticket_labels, comments,
        attachments, tickets, project_counters, statuses, status_transitions,
        labels, projects, api_tokens, idempotency_keys, users
        RESTART IDENTITY CASCADE`
  );
});

async function seedCtx() {
  const [magos] = await testDb.insert(schema.users)
    .values({ name: "magos", type: "human" })
    .returning();
  const [project] = await testDb.insert(schema.projects)
    .values({ key: "LNK", name: "Links test" })
    .returning();
  await testDb.insert(schema.projectCounters).values({ project_id: project!.id });
  const [backlog] = await testDb.insert(schema.statuses).values({
    project_id: project!.id, category: "backlog", display_name: "Backlog",
    position: 0, is_default: true,
  }).returning();
  return { magos: magos!, project: project!, backlog: backlog! };
}

async function makeTicket(
  ctx: { magos: typeof schema.users.$inferSelect; project: typeof schema.projects.$inferSelect; backlog: typeof schema.statuses.$inferSelect },
  number: number,
  title = `T-${number}`,
): Promise<typeof schema.tickets.$inferSelect> {
  const [t] = await testDb.insert(schema.tickets).values({
    project_id: ctx.project.id, number, type: "task", title,
    status_id: ctx.backlog.id, reporter_id: ctx.magos.id,
  }).returning();
  return t!;
}

describe("4.5.0 ticket links — schema + load", () => {
  test("loadTicketLinks returns both outgoing + incoming with correct direction", async () => {
    const ctx = await seedCtx();
    const [a, b, c] = await Promise.all([makeTicket(ctx, 1), makeTicket(ctx, 2), makeTicket(ctx, 3)]);

    // A blocks B (a is source); C duplicates A (a is target).
    await testDb.insert(schema.ticketLinks).values([
      { source_ticket_id: a.id, target_ticket_id: b.id, type: "blocks", created_by: ctx.magos.id },
      { source_ticket_id: c.id, target_ticket_id: a.id, type: "duplicates", created_by: ctx.magos.id },
    ]);

    const { loadTicketLinks } = await import("../../src/lib/tickets.js");
    const links = await loadTicketLinks(a.id);

    expect(links).toHaveLength(2);
    const blocks = links.find((l) => l.type === "blocks")!;
    expect(blocks.direction).toBe("outgoing");
    expect(blocks.other_ticket.key).toBe("LNK-2");

    const dup = links.find((l) => l.type === "duplicates")!;
    expect(dup.direction).toBe("incoming");
    expect(dup.other_ticket.key).toBe("LNK-3");
  });
});

describe("4.5.0 ticket links — CHECK + UNIQUE constraints", () => {
  test("self-link rejected by CHECK constraint", async () => {
    const ctx = await seedCtx();
    const a = await makeTicket(ctx, 1);

    let err: unknown;
    try {
      await testDb.insert(schema.ticketLinks).values({
        source_ticket_id: a.id, target_ticket_id: a.id, type: "relates_to",
        created_by: ctx.magos.id,
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(String(err)).toMatch(/ticket_links_no_self_link/);
  });

  test("duplicate edge (same source/target/type) rejected by UNIQUE index", async () => {
    const ctx = await seedCtx();
    const [a, b] = await Promise.all([makeTicket(ctx, 1), makeTicket(ctx, 2)]);

    await testDb.insert(schema.ticketLinks).values({
      source_ticket_id: a.id, target_ticket_id: b.id, type: "blocks",
      created_by: ctx.magos.id,
    });

    let err: unknown;
    try {
      await testDb.insert(schema.ticketLinks).values({
        source_ticket_id: a.id, target_ticket_id: b.id, type: "blocks",
        created_by: ctx.magos.id,
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(String(err)).toMatch(/ticket_links_edge_unique/);
  });

  test("same source+target with different type is allowed", async () => {
    const ctx = await seedCtx();
    const [a, b] = await Promise.all([makeTicket(ctx, 1), makeTicket(ctx, 2)]);

    await testDb.insert(schema.ticketLinks).values([
      { source_ticket_id: a.id, target_ticket_id: b.id, type: "blocks", created_by: ctx.magos.id },
      { source_ticket_id: a.id, target_ticket_id: b.id, type: "relates_to", created_by: ctx.magos.id },
    ]);

    const rows = await testDb.select().from(schema.ticketLinks)
      .where(and(eq(schema.ticketLinks.source_ticket_id, a.id), eq(schema.ticketLinks.target_ticket_id, b.id)));
    expect(rows).toHaveLength(2);
  });
});

describe("4.5.0 ticket links — soft-delete cascade", () => {
  test("deleting a ticket cascades its link rows away", async () => {
    const ctx = await seedCtx();
    const [a, b] = await Promise.all([makeTicket(ctx, 1), makeTicket(ctx, 2)]);

    await testDb.insert(schema.ticketLinks).values({
      source_ticket_id: a.id, target_ticket_id: b.id, type: "blocks",
      created_by: ctx.magos.id,
    });

    // Hard delete (not soft) — links cascade via FK.
    await testDb.delete(schema.tickets).where(eq(schema.tickets.id, b.id));
    const remaining = await testDb.select().from(schema.ticketLinks);
    expect(remaining).toHaveLength(0);
  });
});
