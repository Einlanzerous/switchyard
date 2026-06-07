// Phase 6 (SWY-96 / 6.1.0) negative-access matrix — the growing safety net for
// project-scoped reads.
//
//   DATABASE_URL_TEST=postgres://...:5432/switchyard_test \
//     bun --cwd server test test/integration/negative-access.test.ts
//
// 6.1.0 BASELINE: no endpoints are scoped yet, so this asserts the enforcement
// PRIMITIVES (lib/authz.ts) behave — the scoped-query filter, the 404-not-403
// read convention, the owner/agent bypass — and that the scoped filter
// preserves cursor pagination + counts (the acceptance criterion).
//
// HOW TO EXTEND (every later 6.1.x sub-milestone — see docs/permissions.md):
//   When you scope an endpoint, add a `describe("6.1.x — <area>")` block here
//   that drives the real handler/lib as the `friend` viewer and asserts:
//     - non-member projects → 404 on detail reads, absent from list reads,
//     - the member project   → still visible.
//   A new scoped read without a matrix row fails review.

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { and, sql } from "drizzle-orm";
import { closeTestDb, schema, testDb } from "../db.js";

process.env.DATABASE_URL = process.env.DATABASE_URL_TEST!;

const authz = await import("../../src/lib/authz.js");
const { buildPage, cursorOrderBy, cursorWhere, decodeCursor } = await import(
  "../../src/lib/pagination.js"
);

afterAll(async () => {
  await closeTestDb();
});

beforeEach(async () => {
  await testDb.execute(
    sql`TRUNCATE events, ticket_labels, comments, attachments, tickets,
        project_counters, statuses, status_transitions, labels, projects,
        api_tokens, idempotency_keys, user_projects, users
        RESTART IDENTITY CASCADE`,
  );
});

// Fixture: owner `magos`, agent `claude`, member `friend` who is a viewer on
// PLEX only; a second project SWY the friend is NOT a member of.
async function fixture() {
  const [magos] = await testDb
    .insert(schema.users)
    .values({ name: "magos", type: "human", instance_role: "owner" })
    .returning();
  const [claude] = await testDb
    .insert(schema.users)
    .values({ name: "claude", type: "agent", instance_role: "member" })
    .returning();
  const [friend] = await testDb
    .insert(schema.users)
    .values({ name: "friend", type: "human", instance_role: "member" })
    .returning();
  const [plex] = await testDb.insert(schema.projects).values({ key: "PLEX", name: "Plex" }).returning();
  const [swy] = await testDb.insert(schema.projects).values({ key: "SWY", name: "Switchyard" }).returning();
  await testDb.insert(schema.projectCounters).values([{ project_id: plex!.id }, { project_id: swy!.id }]);
  const [plexBacklog] = await testDb
    .insert(schema.statuses)
    .values({ project_id: plex!.id, category: "backlog", display_name: "Backlog", position: 0, is_default: true })
    .returning();
  const [swyBacklog] = await testDb
    .insert(schema.statuses)
    .values({ project_id: swy!.id, category: "backlog", display_name: "Backlog", position: 0, is_default: true })
    .returning();
  await testDb.insert(schema.userProjects).values({ user_id: friend!.id, project_id: plex!.id, role: "viewer" });
  return {
    magos: magos!,
    claude: claude!,
    friend: friend!,
    plex: plex!,
    swy: swy!,
    plexBacklog: plexBacklog!,
    swyBacklog: swyBacklog!,
  };
}

describe("6.1.0 baseline — enforcement primitives", () => {
  test("owner + agent bypass scoping: null filter, every project visible", async () => {
    const { magos, claude, swy } = await fixture();
    expect(await authz.visibleProjectFilter(magos, schema.tickets.project_id)).toBeNull();
    expect(await authz.visibleProjectFilter(claude, schema.tickets.project_id)).toBeNull();
    expect(await authz.canSeeProject(magos, swy.id)).toBe(true);
    expect(await authz.canSeeProject(claude, swy.id)).toBe(true);
  });

  test("viewer: only their project visible; non-member read 404s, member read resolves", async () => {
    const { friend, plex, swy } = await fixture();
    expect(await authz.canSeeProject(friend, plex.id)).toBe(true);
    expect(await authz.canSeeProject(friend, swy.id)).toBe(false);
    expect(await authz.visibleProjectIds(friend)).toEqual(new Set([plex.id]));

    await expect(authz.assertProjectReadable(friend, plex.id, "ticket")).resolves.toBeUndefined();
    let err: any;
    try {
      await authz.assertProjectReadable(friend, swy.id, "ticket");
    } catch (e) {
      err = e;
    }
    expect(err?.status).toBe(404);
    expect(err?.code).toBe("not_found");
  });
});

describe("6.1.0 — scoped filter preserves cursor pagination + counts", () => {
  test("a member's filtered ticket query paginates across pages, never leaking non-member rows", async () => {
    const ctx = await fixture();

    // 5 PLEX tickets (visible) + 3 SWY tickets (hidden), interleaved so the
    // cursor walk mixes projects in updated_at order — if scoping leaked, an
    // SWY row would surface mid-page.
    const plan = [ctx.plex, ctx.swy, ctx.plex, ctx.swy, ctx.plex, ctx.swy, ctx.plex, ctx.plex];
    for (let i = 0; i < plan.length; i++) {
      const p = plan[i]!;
      const statusId = p.id === ctx.plex.id ? ctx.plexBacklog.id : ctx.swyBacklog.id;
      await testDb.insert(schema.tickets).values({
        project_id: p.id,
        number: i + 1,
        type: "task",
        title: `T-${i + 1}`,
        status_id: statusId,
        reporter_id: ctx.friend.id,
        updated_at: `2026-06-01T00:00:${String(i).padStart(2, "0")}.000Z`,
      });
    }

    const filter = await authz.visibleProjectFilter(ctx.friend, schema.tickets.project_id);
    expect(filter).not.toBeNull();

    // Count through the filter is 5 (PLEX only) — never the 8 total rows.
    const counted = await testDb.select({ id: schema.tickets.id }).from(schema.tickets).where(filter!);
    expect(counted).toHaveLength(5);

    const plexIds = new Set(counted.map((r) => r.id));

    // Walk every page at limit=2 using the default (updated_at, id) cursor
    // helpers; assert exactly the 5 PLEX rows, no dupes, no SWY leak.
    const limit = 2;
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 10; guard++) {
      const conds = [filter!];
      if (cursor) {
        const cur = decodeCursor(cursor);
        conds.push(cursorWhere(schema.tickets.updated_at, schema.tickets.id, cur!));
      }
      const rows = await testDb
        .select()
        .from(schema.tickets)
        .where(conds.length === 1 ? conds[0]! : and(...conds))
        .orderBy(...cursorOrderBy(schema.tickets.updated_at, schema.tickets.id))
        .limit(limit + 1);
      const page = buildPage(
        rows.map((r) => ({ ...r, updated_at: String(r.updated_at) })),
        limit,
      );
      for (const it of page.items) seen.push(it.id);
      cursor = page.page.next_cursor;
      if (!cursor) break;
    }

    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5); // no row repeated across pages
    expect(seen.every((id) => plexIds.has(id))).toBe(true); // no SWY leak
  });
});
