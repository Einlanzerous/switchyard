// Phase 6 (SWY-96 / 6.1.0) negative-access matrix — the growing safety net for
// project-scoped reads.
//
//   DATABASE_URL_TEST=postgres://...:5432/switchyard_test \
//     bun --cwd server test test/integration/negative-access.test.ts
//
// 6.1.0 layer asserts the enforcement PRIMITIVES (lib/authz.ts) behave — the
// scoped-query filter, the 404-not-403 read convention, the owner/agent bypass
// — and that the scoped filter preserves cursor pagination + counts.
//
// 6.1.1 layer drives the REAL Hono app over HTTP (see the harness below) to
// prove the primitives are wired into the ticket/comment/attachment/link/
// external-ref read handlers — a viewer-on-PLEX gets 404 on every SWY read.
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

// Real-app harness (6.1.1): build the same Hono app prod boots — error handler
// + every route — and issue actual HTTP requests as a minted token. This proves
// the helpers are WIRED into each handler (a lib-level test can't catch a
// handler that forgets to call assertProjectReadable).
const { OpenAPIHono } = await import("@hono/zod-openapi");
const { installErrorHandler } = await import("../../src/errors.js");
const { mountRoutes } = await import("../../src/routes/index.js");
const { generateApiToken } = await import("../../src/lib/id.js");

function buildApp() {
  const app = new OpenAPIHono();
  installErrorHandler(app);
  mountRoutes(app);
  return app;
}
const app = buildApp();

async function mintToken(userId: string, scopes: string[]): Promise<string> {
  const { token, hash, prefix } = generateApiToken();
  await testDb.insert(schema.apiTokens).values({
    user_id: userId,
    name: "matrix-test",
    hashed_token: hash,
    token_prefix: prefix,
    scopes,
  });
  return token;
}

function GET(path: string, token: string) {
  return app.request(path, { headers: { authorization: `Bearer ${token}` } });
}

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

// ─── 6.1.1 — ticket reads + inherited resources (real HTTP) ──────────────────
// The friend is a viewer on PLEX only. Every PLEX read resolves; every SWY read
// — ticket, comment, events, children, link, external-ref, and a direct
// attachment file-id fetch (resolved up through ticket OR comment) — returns
// 404, never 403, so existence stays hidden.
describe("6.1.1 — ticket reads + inherited resources (HTTP, friend=viewer on PLEX)", () => {
  async function seed() {
    const ctx = await fixture();
    const mkTicket = async (
      project: { id: string },
      status: { id: string },
      number: number,
      title: string,
      type: "task" | "epic" = "task",
      parent_id: string | null = null,
    ) => {
      const [t] = await testDb
        .insert(schema.tickets)
        .values({
          project_id: project.id, number, type, title,
          status_id: status.id, reporter_id: ctx.magos.id, parent_id,
        })
        .returning();
      return t!;
    };

    const plexT = await mkTicket(ctx.plex, ctx.plexBacklog, 1, "Plex task");
    const swyT = await mkTicket(ctx.swy, ctx.swyBacklog, 1, "Swy task");
    const swyEpic = await mkTicket(ctx.swy, ctx.swyBacklog, 2, "Swy epic", "epic");
    await mkTicket(ctx.swy, ctx.swyBacklog, 3, "Swy child", "task", swyEpic.id);

    const [plexC] = await testDb.insert(schema.comments)
      .values({ ticket_id: plexT.id, author_id: ctx.magos.id, body: "plex note" }).returning();
    const [swyC] = await testDb.insert(schema.comments)
      .values({ ticket_id: swyT.id, author_id: ctx.magos.id, body: "swy secret" }).returning();

    const att = (vals: Partial<typeof schema.attachments.$inferInsert>) =>
      testDb.insert(schema.attachments).values({
        kind: "text", mime_type: "text/plain", size_bytes: 3,
        storage_path: `x/${Math.abs(vals.size_bytes ?? 1)}.txt`, uploaded_by: ctx.magos.id,
        ...vals,
      } as any).returning().then((r) => r[0]!);
    const plexA = await att({ ticket_id: plexT.id, storage_path: "x/plex.txt" });
    const swyA = await att({ ticket_id: swyT.id, storage_path: "x/swy.txt" });
    const swyCommentA = await att({ comment_id: swyC!.id, storage_path: "x/swyc.txt" });

    await testDb.insert(schema.ticketLinks).values({
      source_ticket_id: swyT.id, target_ticket_id: plexT.id, type: "relates_to", created_by: ctx.magos.id,
    });
    await testDb.insert(schema.ticketExternalRefs).values([
      { ticket_id: plexT.id, kind: "generic", url: "https://example.com/p", created_by: ctx.magos.id },
      { ticket_id: swyT.id, kind: "generic", url: "https://example.com/s", created_by: ctx.magos.id },
    ]);

    const friendToken = await mintToken(ctx.friend.id, ["tickets:read"]);
    const ownerToken = await mintToken(ctx.magos.id, ["admin"]);
    return { ctx, plexT, swyT, swyEpic, plexC: plexC!, swyA, plexA, swyCommentA, friendToken, ownerToken };
  }

  test("list: friend sees only PLEX tickets; owner sees all", async () => {
    const { friendToken, ownerToken } = await seed();

    const fRes = await GET("/v1/tickets", friendToken);
    expect(fRes.status).toBe(200);
    const fBody: any = await fRes.json();
    expect(fBody.items.length).toBeGreaterThan(0);
    expect(fBody.items.every((i: any) => i.project.key === "PLEX")).toBe(true);

    const oRes = await GET("/v1/tickets", ownerToken);
    const oBody: any = await oRes.json();
    const oKeys = new Set(oBody.items.map((i: any) => i.project.key));
    expect(oKeys.has("PLEX")).toBe(true);
    expect(oKeys.has("SWY")).toBe(true);
  });

  test("detail/events/children/comments/links/external-refs: SWY → 404, PLEX → 200", async () => {
    const { friendToken } = await seed();
    const notFound = async (path: string) => {
      const res = await GET(path, friendToken);
      expect(res.status).toBe(404);
      expect((await res.json()).error.code).toBe("not_found");
    };
    const ok = async (path: string) => {
      const res = await GET(path, friendToken);
      expect(res.status).toBe(200);
    };

    // non-member SWY reads → 404
    await notFound("/v1/tickets/SWY-1");
    await notFound("/v1/tickets/SWY-1/events");
    await notFound("/v1/tickets/SWY-2/children");
    await notFound("/v1/tickets/SWY-1/comments");
    await notFound("/v1/tickets/SWY-1/links");
    await notFound("/v1/tickets/SWY-1/external-refs");

    // member PLEX reads → 200
    await ok("/v1/tickets/PLEX-1");
    await ok("/v1/tickets/PLEX-1/comments");
    await ok("/v1/tickets/PLEX-1/links");
    await ok("/v1/tickets/PLEX-1/external-refs");
  });

  test("inherited attachments: direct file-id fetch resolves up to the ticket's project", async () => {
    const { friendToken, ownerToken, swyA, swyCommentA, plexA } = await seed();

    // SWY attachment (direct ticket_id) — download + meta both 404 for friend.
    expect((await GET(`/v1/attachments/${swyA.id}`, friendToken)).status).toBe(404);
    expect((await GET(`/v1/attachments/${swyA.id}/meta`, friendToken)).status).toBe(404);

    // SWY attachment reached via comment_id (inherited path) — also 404.
    expect((await GET(`/v1/attachments/${swyCommentA.id}/meta`, friendToken)).status).toBe(404);

    // PLEX attachment meta → 200 for the member (positive inherited read).
    expect((await GET(`/v1/attachments/${plexA.id}/meta`, friendToken)).status).toBe(200);

    // Owner sees the SWY attachment meta.
    expect((await GET(`/v1/attachments/${swyA.id}/meta`, ownerToken)).status).toBe(200);
  });
});

// ─── 6.1.2 — project config reads (real HTTP) ────────────────────────────────
// The friend (viewer on PLEX) sees only PLEX in the project list and gets 404
// on every SWY config read — project, statuses, transitions, templates, and the
// project-scoped custom field. Global custom fields (project_id NULL) stay
// visible, like the labels catalog.
describe("6.1.2 — project config reads (HTTP, friend=viewer on PLEX)", () => {
  async function seed() {
    const ctx = await fixture();

    // status transition per project (from=null wildcard → backlog).
    await testDb.insert(schema.statusTransitions).values([
      { project_id: ctx.plex.id, from_status_id: null, to_status_id: ctx.plexBacklog.id },
      { project_id: ctx.swy.id, from_status_id: null, to_status_id: ctx.swyBacklog.id },
    ]);

    // one ticket template per project (one-shot via trigger_at).
    const mkTemplate = (project: { id: string }, title: string) =>
      testDb.insert(schema.ticketTemplates).values({
        project_id: project.id, title, type: "task",
        trigger_at: "2026-07-01T00:00:00.000Z", created_by_user_id: ctx.magos.id,
      }).returning().then((r) => r[0]!);
    const plexTpl = await mkTemplate(ctx.plex, "Plex template");
    const swyTpl = await mkTemplate(ctx.swy, "Swy template");

    // custom fields: a global one (project_id NULL) + one per project.
    const mkField = (project_id: string | null, key: string) =>
      testDb.insert(schema.customFields).values({
        project_id, key, label: key, type: "text",
      }).returning().then((r) => r[0]!);
    const globalField = await mkField(null, "global_field");
    const plexField = await mkField(ctx.plex.id, "plex_field");
    const swyField = await mkField(ctx.swy.id, "swy_field");

    const friendToken = await mintToken(ctx.friend.id, ["tickets:read"]);
    const ownerToken = await mintToken(ctx.magos.id, ["admin"]);
    return { ctx, plexTpl, swyTpl, globalField, plexField, swyField, friendToken, ownerToken };
  }

  test("project list: friend sees only PLEX; owner sees both", async () => {
    const { friendToken, ownerToken } = await seed();
    const fBody: any = await (await GET("/v1/projects", friendToken)).json();
    expect(fBody.items.map((p: any) => p.key)).toEqual(["PLEX"]);
    const oKeys = new Set((await (await GET("/v1/projects", ownerToken)).json()).items.map((p: any) => p.key));
    expect(oKeys.has("PLEX") && oKeys.has("SWY")).toBe(true);
  });

  test("project / statuses / transitions / templates: SWY → 404, PLEX → 200", async () => {
    const { friendToken } = await seed();
    const notFound = async (path: string) => {
      const res = await GET(path, friendToken);
      expect(res.status).toBe(404);
      expect((await res.json()).error.code).toBe("not_found");
    };
    const ok = async (path: string) => expect((await GET(path, friendToken)).status).toBe(200);

    await notFound("/v1/projects/SWY");
    await notFound("/v1/projects/SWY/statuses");
    await notFound("/v1/projects/SWY/transitions");
    await notFound("/v1/projects/SWY/templates");

    await ok("/v1/projects/PLEX");
    await ok("/v1/projects/PLEX/statuses");
    await ok("/v1/projects/PLEX/transitions");
    await ok("/v1/projects/PLEX/templates");
  });

  test("templates by id + instances: SWY → 404, PLEX → 200", async () => {
    const { friendToken, plexTpl, swyTpl } = await seed();
    expect((await GET(`/v1/templates/${swyTpl.id}`, friendToken)).status).toBe(404);
    expect((await GET(`/v1/templates/${swyTpl.id}/instances`, friendToken)).status).toBe(404);
    expect((await GET(`/v1/templates/${plexTpl.id}`, friendToken)).status).toBe(200);
    expect((await GET(`/v1/templates/${plexTpl.id}/instances`, friendToken)).status).toBe(200);
  });

  test("custom fields: globals visible, project-scoped gated by membership", async () => {
    const { friendToken, globalField, plexField, swyField } = await seed();

    // GET by id: global + PLEX field → 200; SWY field → 404.
    expect((await GET(`/v1/custom-fields/${globalField.id}`, friendToken)).status).toBe(200);
    expect((await GET(`/v1/custom-fields/${plexField.id}`, friendToken)).status).toBe(200);
    expect((await GET(`/v1/custom-fields/${swyField.id}`, friendToken)).status).toBe(404);

    // ?project= a non-member project → 404; member project → 200.
    expect((await GET("/v1/custom-fields?project=SWY", friendToken)).status).toBe(404);
    expect((await GET("/v1/custom-fields?project=PLEX", friendToken)).status).toBe(200);

    // Unscoped list: globals + PLEX field, never the SWY field.
    const keys = (await (await GET("/v1/custom-fields", friendToken)).json()).items.map((f: any) => f.key);
    expect(keys).toContain("global_field");
    expect(keys).toContain("plex_field");
    expect(keys).not.toContain("swy_field");
  });
});
