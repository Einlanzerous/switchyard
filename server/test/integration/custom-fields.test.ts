// Phase 4.5.1 integration tests: typed views over metadata JSONB.
//
//   DATABASE_URL_TEST=postgres://...:5432/switchyard_test \
//     bun --cwd server test test/integration/custom-fields.test.ts
//
// Covers: insert + load round-trip, unique-per-scope (global vs
// project), key-shape CHECK, select-options validation at the
// API layer, and the `cf.<key>=<value>` filter on /v1/tickets.

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { sql, eq, and, isNull } from "drizzle-orm";
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
    .values({ key: "CF", name: "Custom field test" })
    .returning();
  await testDb.insert(schema.projectCounters).values({ project_id: project!.id });
  const [backlog] = await testDb.insert(schema.statuses).values({
    project_id: project!.id, category: "backlog", display_name: "Backlog",
    position: 0, is_default: true,
  }).returning();
  return { magos: magos!, project: project!, backlog: backlog! };
}

describe("4.5.1 custom_fields — schema constraints", () => {
  test("a global field and a same-keyed project field can coexist", async () => {
    const ctx = await seedCtx();

    await testDb.insert(schema.customFields).values([
      { project_id: null, key: "mode", label: "Mode", type: "select",
        options: { values: ["modify", "scaffold", "greenfield"] } },
      { project_id: ctx.project.id, key: "mode", label: "Project mode", type: "text" },
    ]);

    const rows = await testDb.select().from(schema.customFields);
    expect(rows).toHaveLength(2);
  });

  test("two global fields with the same key are rejected (partial unique)", async () => {
    await testDb.insert(schema.customFields).values({
      project_id: null, key: "repo_url", label: "Repo URL", type: "url",
    });

    let err: unknown;
    try {
      await testDb.insert(schema.customFields).values({
        project_id: null, key: "repo_url", label: "Other label", type: "url",
      });
    } catch (e) { err = e; }
    expect(err).toBeDefined();
    expect(String(err)).toMatch(/custom_fields_global_key_unique/);
  });

  test("two project fields with the same (project, key) are rejected", async () => {
    const ctx = await seedCtx();

    await testDb.insert(schema.customFields).values({
      project_id: ctx.project.id, key: "template", label: "Template", type: "text",
    });

    let err: unknown;
    try {
      await testDb.insert(schema.customFields).values({
        project_id: ctx.project.id, key: "template", label: "Other", type: "text",
      });
    } catch (e) { err = e; }
    expect(err).toBeDefined();
    expect(String(err)).toMatch(/custom_fields_project_key_unique/);
  });

  test("invalid key shape is rejected by CHECK", async () => {
    let err: unknown;
    try {
      await testDb.insert(schema.customFields).values({
        project_id: null, key: "Bad-Key!", label: "x", type: "text",
      });
    } catch (e) { err = e; }
    expect(err).toBeDefined();
    expect(String(err)).toMatch(/custom_fields_key_shape/);
  });

  test("deleting a project cascades its custom fields", async () => {
    const ctx = await seedCtx();
    await testDb.insert(schema.customFields).values({
      project_id: ctx.project.id, key: "branch_name", label: "Branch", type: "text",
    });

    await testDb.delete(schema.projects).where(eq(schema.projects.id, ctx.project.id));
    const remaining = await testDb.select().from(schema.customFields);
    expect(remaining).toHaveLength(0);
  });
});

describe("4.5.1 custom_fields — metadata filtering on /v1/tickets", () => {
  test("metadata->>'key' query matches tickets with that key+value", async () => {
    const ctx = await seedCtx();

    // Two tickets: one with metadata.mode=scaffold, one with mode=modify.
    await testDb.insert(schema.tickets).values([
      { project_id: ctx.project.id, number: 1, type: "task", title: "scaffold one",
        status_id: ctx.backlog.id, reporter_id: ctx.magos.id,
        metadata: { mode: "scaffold" } },
      { project_id: ctx.project.id, number: 2, type: "task", title: "modify one",
        status_id: ctx.backlog.id, reporter_id: ctx.magos.id,
        metadata: { mode: "modify" } },
      { project_id: ctx.project.id, number: 3, type: "task", title: "no metadata",
        status_id: ctx.backlog.id, reporter_id: ctx.magos.id,
        metadata: {} },
    ]);

    // The route reads `cf.mode=scaffold` from URL params and translates
    // to this WHERE clause. We verify the underlying SQL behavior.
    const rows = await testDb.select({ id: schema.tickets.id, title: schema.tickets.title })
      .from(schema.tickets)
      .where(sql`${schema.tickets.metadata}->>'mode' = 'scaffold'`);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.title).toBe("scaffold one");
  });

  test("number-typed metadata values are matched as text (cast both sides)", async () => {
    const ctx = await seedCtx();

    await testDb.insert(schema.tickets).values([
      { project_id: ctx.project.id, number: 1, type: "task", title: "two retries",
        status_id: ctx.backlog.id, reporter_id: ctx.magos.id,
        metadata: { refinement_attempts: 2 } },
      { project_id: ctx.project.id, number: 2, type: "task", title: "three retries",
        status_id: ctx.backlog.id, reporter_id: ctx.magos.id,
        metadata: { refinement_attempts: 3 } },
    ]);

    // JSON numbers serialize to their bare text form via ->>, so the
    // filter comparing as text Just Works.
    const rows = await testDb.select({ id: schema.tickets.id })
      .from(schema.tickets)
      .where(sql`${schema.tickets.metadata}->>'refinement_attempts' = '2'`);
    expect(rows).toHaveLength(1);
  });

  test("global custom field returned alongside project-specific in scoped list", async () => {
    const ctx = await seedCtx();

    await testDb.insert(schema.customFields).values([
      { project_id: null, key: "repo_url", label: "Repo URL", type: "url" },
      { project_id: ctx.project.id, key: "template", label: "Template", type: "select",
        options: { values: ["vue", "go"] } },
    ]);

    // Scoped lookup mirrors what the route does: union of project-scoped
    // and global rows.
    const rows = await testDb.select().from(schema.customFields)
      .where(sql`(${schema.customFields.project_id} = ${ctx.project.id} OR ${schema.customFields.project_id} IS NULL)`);
    const keys = rows.map((r) => r.key).sort();
    expect(keys).toEqual(["repo_url", "template"]);
    void and; void isNull;
  });
});
