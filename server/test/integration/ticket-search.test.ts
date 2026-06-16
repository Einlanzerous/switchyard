// Regression tests: free-text ticket search must match the derived ticket
// key (`<project.key>-<number>`, e.g. `SWY-114`), not just title/description.
//
//   DATABASE_URL_TEST=postgres://...:5432/switchyard_test \
//     bun --cwd server test test/integration/ticket-search.test.ts
//
// Bug: the `text` filter on /v1/tickets only ILIKE'd title + description, so
// searching by key returned nothing — `swy-114` found zero rows even though
// SWY-114 exists. The key isn't a stored column, so the route reconstructs it
// in SQL. These tests assert that reconstructed-key condition.

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { sql, ilike, or, type SQL } from "drizzle-orm";
import { closeTestDb, schema, testDb } from "../db.js";

process.env.DATABASE_URL = process.env.DATABASE_URL_TEST!;

afterAll(async () => { await closeTestDb(); });

beforeEach(async () => {
  await testDb.execute(
    sql`TRUNCATE custom_fields, rule_firings, rules, ticket_links,
        webhook_deliveries, webhook_subscriptions, targets, events,
        ticket_labels, comments, attachments, tickets, project_counters,
        statuses, status_transitions, labels, projects, api_tokens,
        idempotency_keys, users RESTART IDENTITY CASCADE`
  );
});

async function seedCtx() {
  const [magos] = await testDb.insert(schema.users)
    .values({ name: "magos", type: "human" })
    .returning();
  const [project] = await testDb.insert(schema.projects)
    .values({ key: "SWY", name: "Switchyard" })
    .returning();
  await testDb.insert(schema.projectCounters).values({ project_id: project!.id });
  const [backlog] = await testDb.insert(schema.statuses).values({
    project_id: project!.id, category: "backlog", display_name: "Backlog",
    position: 0, is_default: true,
  }).returning();
  return { magos: magos!, project: project!, backlog: backlog! };
}

// Mirror the exact WHERE the /v1/tickets route builds for `text`. Keeping this
// in lockstep with tickets.ts is the point — if the route's matching changes,
// this helper should change with it.
function textCondition(term: string): SQL {
  const pattern = `%${term}%`;
  return or(
    ilike(schema.tickets.title, pattern),
    ilike(schema.tickets.description, pattern),
    sql`EXISTS (SELECT 1 FROM projects p WHERE p.id = ${schema.tickets.project_id} AND (p.key || '-' || ${schema.tickets.number}::text) ILIKE ${pattern})`,
  )!;
}

async function searchKeys(term: string): Promise<string[]> {
  const rows = await testDb
    .select({ number: schema.tickets.number })
    .from(schema.tickets)
    .where(textCondition(term));
  return rows.map((r) => `SWY-${r.number}`).sort();
}

describe("ticket key text search on /v1/tickets", () => {
  beforeEach(async () => {
    const ctx = await seedCtx();
    // Titles/descriptions deliberately do NOT contain the key strings, so a
    // match can only come from the reconstructed-key condition.
    await testDb.insert(schema.tickets).values([
      { project_id: ctx.project.id, number: 1, type: "task", title: "first task",
        description: "alpha", status_id: ctx.backlog.id, reporter_id: ctx.magos.id },
      { project_id: ctx.project.id, number: 14, type: "bug", title: "another",
        description: "beta", status_id: ctx.backlog.id, reporter_id: ctx.magos.id },
      { project_id: ctx.project.id, number: 114, type: "epic", title: "yet another",
        description: "gamma", status_id: ctx.backlog.id, reporter_id: ctx.magos.id },
    ]);
  });

  test("full key matches its ticket (the original bug: swy-114 found nothing)", async () => {
    expect(await searchKeys("swy-114")).toEqual(["SWY-114"]);
  });

  test("key match is case-insensitive", async () => {
    expect(await searchKeys("SWY-14")).toEqual(["SWY-14"]);
  });

  test("partial-key substring matches every key containing it", async () => {
    // `swy-1` is a substring of SWY-1, SWY-14, and SWY-114.
    expect(await searchKeys("swy-1")).toEqual(["SWY-1", "SWY-114", "SWY-14"]);
  });

  test("bare project key surfaces all of that project's tickets", async () => {
    expect(await searchKeys("swy")).toEqual(["SWY-1", "SWY-114", "SWY-14"]);
  });

  test("title text still matches without a key", async () => {
    expect(await searchKeys("yet another")).toEqual(["SWY-114"]);
  });

  test("a non-matching key returns nothing", async () => {
    expect(await searchKeys("swy-999")).toEqual([]);
  });
});
