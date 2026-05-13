// Phase 4.5.3 integration tests: GitHub push-mode webhook receiver +
// auto-detect from PR title / branch convention.
//
//   DATABASE_URL_TEST=postgres://...:5432/switchyard_test \
//     bun --cwd server test test/integration/external-github-webhook.test.ts

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { sql, eq } from "drizzle-orm";
import { closeTestDb, schema, testDb } from "../db.js";
import {
  parseKeyMentions,
  handlePullRequestEvent,
} from "../../src/lib/externalRefs/githubWebhook.js";

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

async function seedCtx(opts: { projectKey?: string } = {}) {
  const [magos] = await testDb.insert(schema.users)
    .values({ name: "magos", type: "human" })
    .returning();
  const [rulesEngine] = await testDb.insert(schema.users)
    .values({ name: "rules-engine", type: "agent" })
    .returning();
  const [project] = await testDb.insert(schema.projects)
    .values({ key: opts.projectKey ?? "SWY", name: "Test" })
    .returning();
  await testDb.insert(schema.projectCounters).values({ project_id: project!.id });
  const [backlog] = await testDb.insert(schema.statuses).values({
    project_id: project!.id, category: "backlog", display_name: "Backlog",
    position: 0, is_default: true,
  }).returning();
  return { magos: magos!, rulesEngine: rulesEngine!, project: project!, backlog: backlog! };
}

async function makeTicket(
  ctx: {
    magos: typeof schema.users.$inferSelect;
    project: typeof schema.projects.$inferSelect;
    backlog: typeof schema.statuses.$inferSelect;
  },
  number = 1,
): Promise<typeof schema.tickets.$inferSelect> {
  const [t] = await testDb.insert(schema.tickets).values({
    project_id: ctx.project.id, number, type: "task", title: `T-${number}`,
    status_id: ctx.backlog.id, reporter_id: ctx.magos.id,
  }).returning();
  return t!;
}

describe("4.5.3 parseKeyMentions", () => {
  test("matches PR-title and branch-name patterns with the configured prefix", () => {
    expect(parseKeyMentions("[SWY-42] Fix the thing", "SWY")).toEqual(["SWY-42"]);
    expect(parseKeyMentions("magos/SWY-7-add-foo", "SWY")).toEqual(["SWY-7"]);
    expect(parseKeyMentions("Resolves SWY-12 and SWY-13", "SWY")).toEqual(["SWY-12", "SWY-13"]);
  });

  test("rejects mid-token false positives (ABBSWY-1 ≠ SWY-1)", () => {
    expect(parseKeyMentions("ABBSWY-1", "SWY")).toEqual([]);
    expect(parseKeyMentions("xSWY-1", "SWY")).toEqual([]);
  });

  test("respects the prefix lock unless wildcard", () => {
    expect(parseKeyMentions("FOO-1 BAR-2", "SWY")).toEqual([]);
    expect(parseKeyMentions("FOO-1 BAR-2", "*")).toEqual(["FOO-1", "BAR-2"]);
  });

  test("dedupes repeats", () => {
    expect(parseKeyMentions("SWY-1 SWY-1 SWY-1", "SWY")).toEqual(["SWY-1"]);
  });
});

describe("4.5.3 handlePullRequestEvent", () => {
  test("PR opened with SWY-N in title creates a github_pr ref tagged open", async () => {
    const ctx = await seedCtx();
    const t = await makeTicket(ctx, 1);

    const updated = await handlePullRequestEvent(
      {
        action: "opened",
        pull_request: {
          html_url: "https://github.com/owner/repo/pull/42",
          title: "[SWY-1] Fix the thing",
          state: "open",
          head: { ref: "magos/SWY-1-fix-the-thing" },
        },
      },
      { keyPrefix: "SWY", rulesEngineUserId: ctx.rulesEngine.id },
    );
    expect(updated).toBe(1);

    const [ref] = await testDb.select().from(schema.ticketExternalRefs)
      .where(eq(schema.ticketExternalRefs.ticket_id, t.id));
    expect(ref!.kind).toBe("github_pr");
    expect(ref!.state).toBe("open");
    expect(ref!.title).toBe("[SWY-1] Fix the thing");
  });

  test("PR closed → ref state transitions to closed + event fires", async () => {
    const ctx = await seedCtx();
    const t = await makeTicket(ctx, 1);

    await handlePullRequestEvent(
      {
        action: "opened",
        pull_request: {
          html_url: "https://github.com/owner/repo/pull/42",
          title: "[SWY-1] Fix",
          state: "open",
          head: { ref: "fix-1" },
        },
      },
      { keyPrefix: "SWY", rulesEngineUserId: ctx.rulesEngine.id },
    );

    await handlePullRequestEvent(
      {
        action: "closed",
        pull_request: {
          html_url: "https://github.com/owner/repo/pull/42",
          title: "[SWY-1] Fix",
          state: "closed",
          merged: true,
          head: { ref: "fix-1" },
        },
      },
      { keyPrefix: "SWY", rulesEngineUserId: ctx.rulesEngine.id },
    );

    const [ref] = await testDb.select().from(schema.ticketExternalRefs)
      .where(eq(schema.ticketExternalRefs.ticket_id, t.id));
    expect(ref!.state).toBe("merged");

    const events = await testDb.select().from(schema.events)
      .where(eq(schema.events.event_type, "ticket.external_ref_state_changed"));
    expect(events.length).toBe(1);
  });

  test("PR with no matching key is a no-op (no rows inserted)", async () => {
    const ctx = await seedCtx();
    await makeTicket(ctx, 1);

    const updated = await handlePullRequestEvent(
      {
        action: "opened",
        pull_request: {
          html_url: "https://github.com/owner/repo/pull/99",
          title: "Just a random PR",
          state: "open",
          head: { ref: "random-branch" },
        },
      },
      { keyPrefix: "SWY", rulesEngineUserId: ctx.rulesEngine.id },
    );
    expect(updated).toBe(0);

    const refs = await testDb.select().from(schema.ticketExternalRefs);
    expect(refs).toHaveLength(0);
  });

  test("a PR mentioning multiple keys links all the live tickets", async () => {
    const ctx = await seedCtx();
    const t1 = await makeTicket(ctx, 1);
    const t2 = await makeTicket(ctx, 2);

    const updated = await handlePullRequestEvent(
      {
        action: "opened",
        pull_request: {
          html_url: "https://github.com/owner/repo/pull/50",
          title: "Resolves SWY-1 and SWY-2",
          state: "open",
          head: { ref: "fix" },
        },
      },
      { keyPrefix: "SWY", rulesEngineUserId: ctx.rulesEngine.id },
    );
    expect(updated).toBe(2);

    const refs = await testDb.select().from(schema.ticketExternalRefs);
    expect(refs).toHaveLength(2);
    const ticketIds = new Set(refs.map((r) => r.ticket_id));
    expect(ticketIds.has(t1.id)).toBe(true);
    expect(ticketIds.has(t2.id)).toBe(true);
  });

  test("re-opening a merged PR does not regress the ref state", async () => {
    const ctx = await seedCtx();
    const t = await makeTicket(ctx, 1);

    // open → merged → re-opened
    for (const action of ["opened", "closed", "reopened"] as const) {
      const merged = action === "closed";
      await handlePullRequestEvent(
        {
          action,
          pull_request: {
            html_url: "https://github.com/owner/repo/pull/42",
            title: "[SWY-1] Fix",
            state: action === "reopened" ? "open" : (merged ? "closed" : "open"),
            merged,
            head: { ref: "fix" },
          },
        },
        { keyPrefix: "SWY", rulesEngineUserId: ctx.rulesEngine.id },
      );
    }

    const [ref] = await testDb.select().from(schema.ticketExternalRefs)
      .where(eq(schema.ticketExternalRefs.ticket_id, t.id));
    // Stays at merged (the highest-water-mark transition seen).
    expect(ref!.state).toBe("merged");
  });

  test("mentioned-but-deleted ticket key is a silent no-op", async () => {
    const ctx = await seedCtx();
    const t = await makeTicket(ctx, 1);
    // Soft-delete it.
    await testDb.update(schema.tickets).set({ deleted_at: new Date().toISOString() })
      .where(eq(schema.tickets.id, t.id));

    const updated = await handlePullRequestEvent(
      {
        action: "opened",
        pull_request: {
          html_url: "https://github.com/owner/repo/pull/1",
          title: "[SWY-1] thing",
          state: "open",
          head: { ref: "x" },
        },
      },
      { keyPrefix: "SWY", rulesEngineUserId: ctx.rulesEngine.id },
    );
    expect(updated).toBe(0);

    const refs = await testDb.select().from(schema.ticketExternalRefs);
    expect(refs).toHaveLength(0);
  });
});
