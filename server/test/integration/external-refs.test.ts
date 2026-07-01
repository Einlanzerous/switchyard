// Phase 4.5.2 integration tests: external refs (manual attach + polling
// data layer). The HTTP poller hits GitHub at runtime — we don't try to
// stub that here; the data layer (CRUD + URL→kind detection + event
// emission on add/remove) is what's covered.
//
//   DATABASE_URL_TEST=postgres://...:5432/switchyard_test \
//     bun --cwd server test test/integration/external-refs.test.ts

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { sql, eq } from "drizzle-orm";
import { closeTestDb, schema, testDb } from "../db.js";
import { detectKind, urlMatchesKind, parseGitHubUrl } from "../../src/lib/externalRefs/detectKind.js";
import { selectPollCandidates } from "../../src/lib/externalRefs/poller.js";

process.env.DATABASE_URL = process.env.DATABASE_URL_TEST!;

afterAll(async () => { await closeTestDb(); });

beforeEach(async () => {
  await testDb.execute(
    sql`TRUNCATE ticket_external_refs, custom_fields, rule_firings, rules,
        ticket_links, webhook_deliveries, webhook_subscriptions, targets,
        events, ticket_labels, comments, attachments, tickets,
        project_counters, statuses, status_transitions, labels, projects,
        api_tokens, idempotency_keys, users RESTART IDENTITY CASCADE`
  );
});

async function seedCtx() {
  const [magos] = await testDb.insert(schema.users)
    .values({ name: "magos", type: "human" })
    .returning();
  const [project] = await testDb.insert(schema.projects)
    .values({ key: "REF", name: "External refs test" })
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
  number = 1,
): Promise<typeof schema.tickets.$inferSelect> {
  const [t] = await testDb.insert(schema.tickets).values({
    project_id: ctx.project.id, number, type: "task", title: `T-${number}`,
    status_id: ctx.backlog.id, reporter_id: ctx.magos.id,
  }).returning();
  return t!;
}

describe("4.5.2 detectKind", () => {
  test("github_pr URLs match the canonical shape", () => {
    expect(detectKind("https://github.com/foo/bar/pull/42")).toBe("github_pr");
    expect(detectKind("https://github.com/foo/bar/pull/42/files")).toBe("generic");
    expect(detectKind("https://github.com/foo/bar/pull/42?diff=split")).toBe("github_pr");
  });

  test("github_issue / github_commit / github_action shapes are recognized", () => {
    expect(detectKind("https://github.com/foo/bar/issues/7")).toBe("github_issue");
    expect(detectKind("https://github.com/foo/bar/commit/abc1234")).toBe("github_commit");
    expect(detectKind("https://github.com/foo/bar/actions/runs/9999")).toBe("github_action");
  });

  test("non-GitHub URLs fall through to generic", () => {
    expect(detectKind("https://gitlab.com/foo/bar/-/merge_requests/3")).toBe("generic");
    expect(detectKind("https://example.com/anything")).toBe("generic");
  });

  test("urlMatchesKind sanity-checks explicit kind overrides", () => {
    expect(urlMatchesKind("https://github.com/foo/bar/pull/42", "github_pr")).toBe(true);
    expect(urlMatchesKind("https://github.com/foo/bar/issues/7", "github_pr")).toBe(false);
    expect(urlMatchesKind("https://example.com/", "generic")).toBe(true);
  });

  test("parseGitHubUrl extracts owner/repo/rest", () => {
    const p = parseGitHubUrl("https://github.com/foo/bar/pull/42");
    expect(p?.owner).toBe("foo");
    expect(p?.repo).toBe("bar");
    expect(p?.rest).toBe("pull/42");
  });
});

describe("4.5.2 ticket_external_refs — schema", () => {
  test("the same URL can't be attached twice to one ticket (uniqueness)", async () => {
    const ctx = await seedCtx();
    const t = await makeTicket(ctx);

    await testDb.insert(schema.ticketExternalRefs).values({
      ticket_id: t.id, kind: "github_pr",
      url: "https://github.com/foo/bar/pull/42",
      created_by: ctx.magos.id,
    });

    let err: unknown;
    try {
      await testDb.insert(schema.ticketExternalRefs).values({
        ticket_id: t.id, kind: "github_pr",
        url: "https://github.com/foo/bar/pull/42",
        created_by: ctx.magos.id,
      });
    } catch (e) { err = e; }
    expect(err).toBeDefined();
    expect(String(err)).toMatch(/ticket_external_refs_url_unique/);
  });

  test("the same URL CAN attach to two different tickets (one PR fixes many)", async () => {
    const ctx = await seedCtx();
    const t1 = await makeTicket(ctx, 1);
    const t2 = await makeTicket(ctx, 2);

    await testDb.insert(schema.ticketExternalRefs).values([
      { ticket_id: t1.id, kind: "github_pr", url: "https://github.com/foo/bar/pull/42", created_by: ctx.magos.id },
      { ticket_id: t2.id, kind: "github_pr", url: "https://github.com/foo/bar/pull/42", created_by: ctx.magos.id },
    ]);
    const rows = await testDb.select().from(schema.ticketExternalRefs);
    expect(rows).toHaveLength(2);
  });

  test("hard-deleting a ticket cascades its refs", async () => {
    const ctx = await seedCtx();
    const t = await makeTicket(ctx);
    await testDb.insert(schema.ticketExternalRefs).values({
      ticket_id: t.id, kind: "generic", url: "https://example.com/", created_by: ctx.magos.id,
    });

    await testDb.delete(schema.tickets).where(eq(schema.tickets.id, t.id));
    const remaining = await testDb.select().from(schema.ticketExternalRefs);
    expect(remaining).toHaveLength(0);
  });
});

// SWY-128: the poll queue starved never-polled refs behind a backlog of
// terminal (merged) refs, so PR-merge auto-close silently stopped firing.
// These lock in the two fixes: NULLS FIRST ordering + skipping merged refs.
describe("SWY-128 poll candidate selection", () => {
  const MIN = 60_000;

  async function attach(
    ctx: Awaited<ReturnType<typeof seedCtx>>,
    t: typeof schema.tickets.$inferSelect,
    url: string,
    opts: { polled_at?: string | null; state?: "open" | "closed" | "merged" | "success" | "failed" | null } = {},
  ): Promise<void> {
    await testDb.insert(schema.ticketExternalRefs).values({
      ticket_id: t.id, kind: "github_pr", url, created_by: ctx.magos.id,
      polled_at: opts.polled_at ?? null,
      state: opts.state ?? null,
    });
  }

  test("never-polled refs are selected before stale ones (NULLS FIRST)", async () => {
    const ctx = await seedCtx();
    const t = await makeTicket(ctx);
    const now = Date.now();
    await attach(ctx, t, "https://github.com/foo/bar/pull/1", {
      polled_at: new Date(now - 10 * MIN).toISOString(), state: "open",
    });
    await attach(ctx, t, "https://github.com/foo/bar/pull/2", { polled_at: null });

    const rows = await selectPollCandidates(testDb, now);
    expect(rows.map((r) => r.url)).toEqual([
      "https://github.com/foo/bar/pull/2", // never-polled jumps the queue
      "https://github.com/foo/bar/pull/1",
    ]);
  });

  test("merged refs are never re-polled, even when stale", async () => {
    const ctx = await seedCtx();
    const t = await makeTicket(ctx);
    const now = Date.now();
    await attach(ctx, t, "https://github.com/foo/bar/pull/1", {
      polled_at: new Date(now - 10 * MIN).toISOString(), state: "merged",
    });
    await attach(ctx, t, "https://github.com/foo/bar/pull/2", {
      polled_at: new Date(now - 10 * MIN).toISOString(), state: "open",
    });

    const urls = (await selectPollCandidates(testDb, now)).map((r) => r.url);
    expect(urls).toContain("https://github.com/foo/bar/pull/2");
    expect(urls).not.toContain("https://github.com/foo/bar/pull/1");
  });

  test("recently-polled non-merged refs are not yet due", async () => {
    const ctx = await seedCtx();
    const t = await makeTicket(ctx);
    const now = Date.now();
    await attach(ctx, t, "https://github.com/foo/bar/pull/1", {
      polled_at: new Date(now - 1 * MIN).toISOString(), state: "open",
    });

    expect(await selectPollCandidates(testDb, now)).toHaveLength(0);
  });

  test("a never-polled ref behind a >batch-size wall of stale merged refs is still selected", async () => {
    const ctx = await seedCtx();
    const t = await makeTicket(ctx);
    const now = Date.now();
    // 30 stale merged refs (> the batch limit of 20). Under the old
    // NULLS-LAST + no-exclusion query these filled every batch forever.
    for (let i = 0; i < 30; i++) {
      await attach(ctx, t, `https://github.com/foo/bar/pull/${100 + i}`, {
        polled_at: new Date(now - 10 * MIN).toISOString(), state: "merged",
      });
    }
    await attach(ctx, t, "https://github.com/foo/bar/pull/1", { polled_at: null });

    const rows = await selectPollCandidates(testDb, now);
    expect(rows.map((r) => r.url)).toContain("https://github.com/foo/bar/pull/1");
    expect(rows.every((r) => r.state !== "merged")).toBe(true);
  });
});
