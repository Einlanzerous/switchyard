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
import { and, inArray, sql } from "drizzle-orm";
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

function body(method: string, path: string, token: string, json: unknown) {
  return app.request(path, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(json),
  });
}
const POST = (path: string, token: string, json: unknown) => body("POST", path, token, json);
const PATCH2 = (path: string, token: string, json: unknown) => body("PATCH", path, token, json);
const DELETE = (path: string, token: string) =>
  app.request(path, { method: "DELETE", headers: { authorization: `Bearer ${token}` } });

afterAll(async () => {
  await closeTestDb();
});

beforeEach(async () => {
  await testDb.execute(
    sql`TRUNCATE events, ticket_labels, comments, attachments, tickets,
        boards, project_counters, statuses, status_transitions, labels, projects,
        api_tokens, idempotency_keys, user_projects, users,
        rules, targets, webhook_subscriptions
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

// ─── 6.1.3 — boards: cross-project column drop (real HTTP) ────────────────────
// Boards are saved views over a many-to-many set of projects. The friend (viewer
// on PLEX) sees a board iff they belong to ≥1 of its projects, and within a
// visible board only their own projects' refs + cards. A board they can see no
// project of is dropped from the list AND 404s on direct fetch — never a
// visible-but-broken board. The card filter is also what keeps client-side
// swimlanes (project/assignee/epic/type) from surfacing a non-member row.
describe("6.1.3 — boards: cross-project column drop (HTTP, friend=viewer on PLEX)", () => {
  async function seed() {
    const ctx = await fixture();

    // A card in each project so columns have content to (not) leak.
    const mkTicket = (project: { id: string }, status: { id: string }, number: number, title: string) =>
      testDb.insert(schema.tickets).values({
        project_id: project.id, number, type: "task", title,
        status_id: status.id, reporter_id: ctx.magos.id,
      }).returning().then((r) => r[0]!);
    const plexT = await mkTicket(ctx.plex, ctx.plexBacklog, 1, "Plex card");
    const swyT = await mkTicket(ctx.swy, ctx.swyBacklog, 1, "Swy card");

    const mkBoard = async (name: string, projectIds: string[], auto = false) => {
      const [b] = await testDb.insert(schema.boards)
        .values({ name, layout: "kanban", auto_include_all_projects: auto }).returning();
      await testDb.insert(schema.boardProjects)
        .values(projectIds.map((project_id) => ({ board_id: b!.id, project_id })));
      return b!;
    };
    // Single-project boards + a cross-project board mimicking the auto
    // "All projects" board from 4.9 (auto_include_all_projects = true).
    const plexBoard = await mkBoard("Plex board", [ctx.plex.id]);
    const swyBoard = await mkBoard("Swy board", [ctx.swy.id]);
    const allBoard = await mkBoard("All projects", [ctx.plex.id, ctx.swy.id], true);

    const friendToken = await mintToken(ctx.friend.id, ["tickets:read"]);
    const ownerToken = await mintToken(ctx.magos.id, ["admin"]);
    return { ctx, plexT, swyT, plexBoard, swyBoard, allBoard, friendToken, ownerToken };
  }

  test("board list: SWY-only board absent; cross-project board present with PLEX-only refs", async () => {
    const { friendToken, ownerToken } = await seed();

    const fBody: any = await (await GET("/v1/boards", friendToken)).json();
    const fNames = fBody.items.map((b: any) => b.name);
    expect(fNames).toContain("Plex board");
    expect(fNames).toContain("All projects");
    expect(fNames).not.toContain("Swy board"); // member of none of its projects → dropped

    // Every surviving board exposes only PLEX in its project refs.
    for (const b of fBody.items) {
      expect(b.projects.map((p: any) => p.key)).toEqual(["PLEX"]);
    }

    // Owner sees all three; the cross-project board keeps both refs.
    const oBody: any = await (await GET("/v1/boards", ownerToken)).json();
    const oNames = new Set(oBody.items.map((b: any) => b.name));
    expect(oNames.has("Plex board") && oNames.has("Swy board") && oNames.has("All projects")).toBe(true);
    const oAll = oBody.items.find((b: any) => b.name === "All projects");
    expect(new Set(oAll.projects.map((p: any) => p.key))).toEqual(new Set(["PLEX", "SWY"]));
  });

  test("get: single-project SWY board → 404; PLEX board + cross-project board → 200 w/ PLEX-only refs", async () => {
    const { friendToken, plexBoard, swyBoard, allBoard } = await seed();

    expect((await GET(`/v1/boards/${swyBoard.id}`, friendToken)).status).toBe(404);

    const plexRes = await GET(`/v1/boards/${plexBoard.id}`, friendToken);
    expect(plexRes.status).toBe(200);
    expect((await plexRes.json()).projects.map((p: any) => p.key)).toEqual(["PLEX"]);

    const allRes = await GET(`/v1/boards/${allBoard.id}`, friendToken);
    expect(allRes.status).toBe(200);
    expect((await allRes.json()).projects.map((p: any) => p.key)).toEqual(["PLEX"]);
  });

  test("columns: SWY board → 404; cross-project board drops SWY cards + refs, never leaks a SWY ticket", async () => {
    const { friendToken, ownerToken, swyBoard, allBoard } = await seed();

    expect((await GET(`/v1/boards/${swyBoard.id}/columns`, friendToken)).status).toBe(404);

    // Cross-project board: friend gets PLEX-only board refs and PLEX-only cards.
    const fRes = await GET(`/v1/boards/${allBoard.id}/columns`, friendToken);
    expect(fRes.status).toBe(200);
    const fBody: any = await fRes.json();
    expect(fBody.board.projects.map((p: any) => p.key)).toEqual(["PLEX"]);
    const fCards = fBody.columns.flatMap((col: any) => col.tickets);
    expect(fCards.length).toBeGreaterThan(0);
    expect(fCards.every((t: any) => t.project.key === "PLEX")).toBe(true); // no SWY card leak

    // Owner sees both projects' cards on the same board.
    const oBody: any = await (await GET(`/v1/boards/${allBoard.id}/columns`, ownerToken)).json();
    const oKeys = new Set(oBody.columns.flatMap((col: any) => col.tickets).map((t: any) => t.project.key));
    expect(oKeys.has("PLEX") && oKeys.has("SWY")).toBe(true);
  });
});

// ─── 6.1.4 — aggregates & feeds (real HTTP) ──────────────────────────────────
// Events, stats, and search all silently aggregated across every project. The
// friend (viewer on PLEX) now sees PLEX-only everywhere; a `stranger` member
// with ZERO projects gets empty aggregates — never the all-projects fallback
// (the `projectIds.length === 0` conflation guard). Notifications are the one
// deliberate carve-out: own @-mentions stay visible cross-project (decision B,
// 2026-06-07) — read visibility is soft, write isolation is the goal.
describe("6.1.4 — aggregates & feeds (HTTP, friend=viewer on PLEX, stranger=0 projects)", () => {
  const WINDOW = "since=2026-06-01T00:00:00.000Z&until=2026-06-30T00:00:00.000Z";

  async function seed() {
    const ctx = await fixture();
    const [stranger] = await testDb.insert(schema.users)
      .values({ name: "stranger", type: "human", instance_role: "member" }).returning();
    // stranger gets NO user_projects row → zero visible projects.

    // in_progress statuses so we can seed stale tickets.
    const [plexProg] = await testDb.insert(schema.statuses)
      .values({ project_id: ctx.plex.id, category: "in_progress", display_name: "In Progress", position: 1 }).returning();
    const [swyProg] = await testDb.insert(schema.statuses)
      .values({ project_id: ctx.swy.id, category: "in_progress", display_name: "In Progress", position: 1 }).returning();

    const mkTicket = (
      project: { id: string }, status: { id: string }, number: number, title: string,
      updated_at?: string,
    ) => testDb.insert(schema.tickets).values({
      project_id: project.id, number, type: "task", title,
      status_id: status.id, reporter_id: ctx.magos.id,
      ...(updated_at ? { updated_at } : {}),
    }).returning().then((r) => r[0]!);

    // Backlog tickets (project stats counts) + long-stale in_progress tickets.
    await mkTicket(ctx.plex, ctx.plexBacklog, 1, "Plex backlog");
    await mkTicket(ctx.swy, ctx.swyBacklog, 1, "Swy backlog");
    await mkTicket(ctx.plex, plexProg!, 2, "Plex stale", "2020-01-01T00:00:00.000Z");
    const swyStale = await mkTicket(ctx.swy, swyProg!, 2, "Swy stale", "2020-01-01T00:00:00.000Z");

    // Events: a ticket.closed in window per project (throughput) + a generic feed event.
    await testDb.insert(schema.events).values([
      { project_id: ctx.plex.id, actor_id: ctx.magos.id, event_type: "ticket.closed", created_at: "2026-06-05T00:00:00.000Z", payload: {} },
      { project_id: ctx.swy.id, actor_id: ctx.magos.id, event_type: "ticket.closed", created_at: "2026-06-05T00:00:00.000Z", payload: {} },
      { project_id: ctx.plex.id, actor_id: ctx.magos.id, event_type: "ticket.created", payload: {} },
      { project_id: ctx.swy.id, actor_id: ctx.magos.id, event_type: "ticket.created", payload: {} },
    ]);

    // Notification for friend on a SWY ticket — the carve-out under test.
    await testDb.insert(schema.notifications).values({
      user_id: ctx.friend.id, kind: "mention", actor_id: ctx.magos.id,
      ticket_id: swyStale.id, payload: { source: "comment", snippet: "ping @friend" },
    });

    const friendToken = await mintToken(ctx.friend.id, ["tickets:read"]);
    const strangerToken = await mintToken(stranger!.id, ["tickets:read"]);
    const ownerToken = await mintToken(ctx.magos.id, ["admin"]);
    return { ctx, friendToken, strangerToken, ownerToken };
  }

  test("events feed: friend sees only PLEX events; ?project=SWY → 404; owner sees both", async () => {
    const { friendToken, ownerToken } = await seed();
    // 4 events seeded (2 PLEX, 2 SWY). The Event API shape carries no project_id,
    // so assert scoping by count: friend (PLEX viewer) sees exactly the 2 PLEX.
    const fBody: any = await (await GET("/v1/events", friendToken)).json();
    expect(fBody.items.length).toBe(2);

    // Naming a project they can't see → 404, not its audit trail.
    expect((await GET("/v1/events?project=SWY", friendToken)).status).toBe(404);
    const plexScoped: any = await (await GET("/v1/events?project=PLEX", friendToken)).json();
    expect(plexScoped.items.length).toBe(2);

    // Owner sees all four.
    expect((await (await GET("/v1/events", ownerToken)).json()).items.length).toBe(4);
  });

  test("project stats: SWY → 404, PLEX → 200; bulk list scoped; stranger empty", async () => {
    const { friendToken, strangerToken, ownerToken } = await seed();

    expect((await GET("/v1/projects/SWY/stats", friendToken)).status).toBe(404);
    expect((await GET("/v1/projects/PLEX/stats", friendToken)).status).toBe(200);

    // /v1/stats/projects bulk directory.
    const fKeys = (await (await GET("/v1/stats/projects", friendToken)).json()).items.map((i: any) => i.project.key);
    expect(fKeys).toEqual(["PLEX"]);
    const oKeys = new Set((await (await GET("/v1/stats/projects", ownerToken)).json()).items.map((i: any) => i.project.key));
    expect(oKeys.has("PLEX") && oKeys.has("SWY")).toBe(true);
    // Zero-project member → empty directory, NOT all projects.
    expect((await (await GET("/v1/stats/projects", strangerToken)).json()).items).toEqual([]);
  });

  test("throughput / cycle-time / cfd: scoped; stranger never gets all-data", async () => {
    const { friendToken, strangerToken, ownerToken } = await seed();

    // Friend: 1 PLEX closure in window; owner: 2 (PLEX+SWY).
    expect((await (await GET(`/v1/stats/throughput?${WINDOW}`, friendToken)).json()).total).toBe(1);
    expect((await (await GET(`/v1/stats/throughput?${WINDOW}`, ownerToken)).json()).total).toBe(2);
    // Friend naming SWY → empty series, not SWY's closures.
    expect((await (await GET(`/v1/stats/throughput?${WINDOW}&project=SWY`, friendToken)).json()).total).toBe(0);
    // CRITICAL: zero-project member with NO ?project= must get empty, not all 2.
    expect((await (await GET(`/v1/stats/throughput?${WINDOW}`, strangerToken)).json()).total).toBe(0);

    // cycle-time + cfd share the same scope path — assert the empty branch holds.
    expect((await (await GET(`/v1/stats/cycle-time?${WINDOW}`, strangerToken)).json()).count).toBe(0);
    expect((await (await GET(`/v1/stats/cumulative-flow?${WINDOW}`, strangerToken)).json()).points).toEqual([]);
  });

  test("stale rollup: friend sees only PLEX; stranger empty; owner both", async () => {
    const { ctx, friendToken, strangerToken, ownerToken } = await seed();

    const fItems = (await (await GET("/v1/stats/stale", friendToken)).json()).items;
    expect(fItems.length).toBe(1);
    expect(fItems[0].project.key).toBe("PLEX");

    expect((await (await GET("/v1/stats/stale", strangerToken)).json()).items).toEqual([]);

    const oKeys = new Set((await (await GET("/v1/stats/stale", ownerToken)).json()).items.map((i: any) => i.project.key));
    expect(oKeys.has("PLEX") && oKeys.has("SWY")).toBe(true);
    void ctx;
  });

  test("search DSL (already scoped in 6.1.1): ?project=SWY → empty, ?project=PLEX → rows", async () => {
    const { friendToken } = await seed();
    const swy = (await (await GET("/v1/tickets?project=SWY", friendToken)).json()).items;
    expect(swy).toEqual([]);
    const plex = (await (await GET("/v1/tickets?project=PLEX", friendToken)).json()).items;
    expect(plex.length).toBeGreaterThan(0);
    expect(plex.every((t: any) => t.project.key === "PLEX")).toBe(true);
  });

  test("notifications carve-out (B): own @-mention on a non-member SWY ticket stays visible", async () => {
    const { friendToken } = await seed();
    const body: any = await (await GET("/v1/users/me/notifications", friendToken)).json();
    // The SWY-ticket notification is present despite friend not being a SWY member.
    const swyNote = body.items.find((n: any) => n.ticket?.project?.key === "SWY");
    expect(swyNote).toBeTruthy();
  });
});

describe("6.1.5 — admin surfaces (HTTP, friend=viewer on PLEX)", () => {
  function PATCH(path: string, token: string, body: unknown) {
    return app.request(path, {
      method: "PATCH",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async function seed() {
    const ctx = await fixture();
    // mate: a co-member of friend on PLEX → friend SHOULD see them in the directory.
    const [mate] = await testDb.insert(schema.users)
      .values({ name: "mate", type: "human", instance_role: "member" }).returning();
    await testDb.insert(schema.userProjects).values({ user_id: mate!.id, project_id: ctx.plex.id, role: "viewer" });
    // outsider: member of SWY only → friend should NOT see them.
    const [outsider] = await testDb.insert(schema.users)
      .values({ name: "outsider", type: "human", instance_role: "member" }).returning();
    await testDb.insert(schema.userProjects).values({ user_id: outsider!.id, project_id: ctx.swy.id, role: "viewer" });

    // Admin infra, all referencing the project friend can't see where applicable.
    const [rule] = await testDb.insert(schema.rules).values({
      project_id: ctx.swy.id, name: "swy rule", trigger_event_types: ["ticket.created"],
      conditions: {}, actions: [], webhook_secret: "wh",
    }).returning();
    await testDb.insert(schema.targets).values({ name: "n8n", url: "https://n8n.example/hook", hmac_secret: "s" });
    const [sub] = await testDb.insert(schema.webhookSubscriptions).values({
      url: "https://hooks.example/x", event_types: ["ticket.created"], secret: "s",
    }).returning();

    const friendToken = await mintToken(ctx.friend.id, ["tickets:read"]);
    const ownerToken = await mintToken(ctx.magos.id, ["admin"]);
    // Agent with a plain read token — proves the gate keys on instance role
    // (agent), not on token scope, so imperium-loop reads keep working.
    const agentToken = await mintToken(ctx.claude.id, ["tickets:read"]);
    return { ctx, mate: mate!, outsider: outsider!, rule: rule!, sub: sub!, friendToken, ownerToken, agentToken };
  }

  test("admin infra reads: friend → 403; owner + agent → 200", async () => {
    const { rule, sub, friendToken, ownerToken, agentToken } = await seed();

    for (const path of ["/v1/rules", "/v1/targets", "/v1/webhooks"]) {
      expect((await GET(path, friendToken)).status).toBe(403);
      expect((await GET(path, ownerToken)).status).toBe(200);
      expect((await GET(path, agentToken)).status).toBe(200);
    }
    // Detail + debugging sublists gate the same way (before any row lookup).
    expect((await GET(`/v1/rules/${rule.id}`, friendToken)).status).toBe(403);
    expect((await GET(`/v1/rules/${rule.id}/firings`, friendToken)).status).toBe(403);
    expect((await GET(`/v1/webhooks/${sub.id}/deliveries`, friendToken)).status).toBe(403);
    expect((await GET(`/v1/rules/${rule.id}`, ownerToken)).status).toBe(200);
    expect((await GET(`/v1/webhooks/${sub.id}/deliveries`, ownerToken)).status).toBe(200);
  });

  test("user directory: member sees co-members ∪ agents ∪ self; owner sees all", async () => {
    const { friendToken, ownerToken } = await seed();

    const fNames = new Set(
      (await (await GET("/v1/users", friendToken)).json()).items.map((u: any) => u.name),
    );
    // friend + mate (PLEX co-member) + claude (agent). NOT magos (owner, no
    // membership row), NOT outsider (SWY-only).
    expect(fNames).toEqual(new Set(["friend", "mate", "claude"]));

    const oNames = new Set(
      (await (await GET("/v1/users", ownerToken)).json()).items.map((u: any) => u.name),
    );
    for (const n of ["magos", "claude", "friend", "mate", "outsider"]) expect(oNames.has(n)).toBe(true);
  });

  test("user detail: 404 outside the directory, 200 for co-member + self", async () => {
    const { ctx, mate, outsider, friendToken } = await seed();
    expect((await GET(`/v1/users/${outsider.id}`, friendToken)).status).toBe(404);
    expect((await GET(`/v1/users/${mate.id}`, friendToken)).status).toBe(200);
    expect((await GET(`/v1/users/${ctx.friend.id}`, friendToken)).status).toBe(200);
  });

  test("token metadata is admin-only: friend → 403 (even own), owner → 200", async () => {
    const { ctx, friendToken, ownerToken } = await seed();
    expect((await GET(`/v1/users/${ctx.friend.id}/tokens`, friendToken)).status).toBe(403);
    expect((await GET(`/v1/users/${ctx.magos.id}/tokens`, ownerToken)).status).toBe(200);
  });

  test("settings: readable by a member (display config), PATCH admin-only", async () => {
    const { friendToken, ownerToken } = await seed();
    expect((await GET("/v1/settings", friendToken)).status).toBe(200);
    expect((await PATCH("/v1/settings", friendToken, { stale_in_progress_days: 14 })).status).toBe(403);
    expect((await PATCH("/v1/settings", ownerToken, { stale_in_progress_days: 14 })).status).toBe(200);
  });
});

// ─── 6.2 — write-path enforcement (real HTTP) ────────────────────────────────
// Reads are scoped (6.1.x); now writes gate on the PROJECT ROLE. Tokens here
// carry BROAD scopes (tickets:write + comments:write + projects:manage) so each
// test proves the *role* gate blocks even when the *token* would allow it —
// effective capability = token scope ∩ project role. Non-member / under-
// privileged writes return 403 (reads stay 404). Owners + agents bypass.
describe("6.2 — write-path enforcement (HTTP)", () => {
  // viewer=friend/PLEX, editor=editor/PLEX, admin=padmin/PLEX (all instance member).
  const BROAD = ["tickets:write", "comments:write", "projects:manage"];
  const RULE = { name: "r", trigger_event_types: ["ticket.created"], actions: [{ type: "comment", body: "x" }] };

  async function seed() {
    const ctx = await fixture();
    const [editor] = await testDb.insert(schema.users)
      .values({ name: "editor", type: "human", instance_role: "member" }).returning();
    await testDb.insert(schema.userProjects).values({ user_id: editor!.id, project_id: ctx.plex.id, role: "editor" });
    const [padmin] = await testDb.insert(schema.users)
      .values({ name: "padmin", type: "human", instance_role: "member" }).returning();
    await testDb.insert(schema.userProjects).values({ user_id: padmin!.id, project_id: ctx.plex.id, role: "admin" });

    // A PLEX ticket (member writes) + a SWY ticket (non-member writes → 403).
    const mk = (project: { id: string }, status: { id: string }, number: number, title: string) =>
      testDb.insert(schema.tickets).values({
        project_id: project.id, number, type: "task", title,
        status_id: status.id, reporter_id: ctx.magos.id,
      }).returning().then((r) => r[0]!);
    const plexT = await mk(ctx.plex, ctx.plexBacklog, 1, "Plex task");
    const swyT = await mk(ctx.swy, ctx.swyBacklog, 1, "Swy task");
    // Manually-numbered seed rows must advance the counter so POST-create
    // allocations don't collide on (project_id, number).
    await testDb.update(schema.projectCounters).set({ last_used_number: 1 })
      .where(inArray(schema.projectCounters.project_id, [ctx.plex.id, ctx.swy.id]));

    return {
      ctx, plexT, swyT,
      friendToken: await mintToken(ctx.friend.id, BROAD),
      editorToken: await mintToken(editor!.id, BROAD),
      padminToken: await mintToken(padmin!.id, BROAD),
      ownerToken: await mintToken(ctx.magos.id, ["admin"]),
      agentToken: await mintToken(ctx.claude.id, ["tickets:write"]),
    };
  }

  test("viewer (broad token) is blocked on every write, on member + non-member projects", async () => {
    const { friendToken } = await seed();
    // PLEX (member as viewer) → 403, NOT a silent success.
    expect((await POST("/v1/tickets", friendToken, { project_key: "PLEX", type: "task", title: "x" })).status).toBe(403);
    expect((await PATCH2("/v1/tickets/PLEX-1", friendToken, { title: "y" })).status).toBe(403);
    expect((await POST("/v1/tickets/PLEX-1/comments", friendToken, { body: "hi" })).status).toBe(403);
    expect((await DELETE("/v1/tickets/PLEX-1", friendToken)).status).toBe(403);
    // SWY (not a member at all) → 403 on write, not the 404 reads get.
    expect((await POST("/v1/tickets", friendToken, { project_key: "SWY", type: "task", title: "x" })).status).toBe(403);
  });

  test("editor: ticket + comment writes succeed on PLEX; project config is 403", async () => {
    const { editorToken } = await seed();
    expect((await POST("/v1/tickets", editorToken, { project_key: "PLEX", type: "task", title: "new" })).status).toBe(201);
    expect((await POST("/v1/tickets/PLEX-1/comments", editorToken, { body: "hi" })).status).toBe(201);
    expect((await PATCH2("/v1/tickets/PLEX-1", editorToken, { title: "edited" })).status).toBe(200);
    // Config requires `manage` (project admin) — editor cannot.
    expect((await POST("/v1/projects/PLEX/statuses", editorToken, { category: "in_progress", display_name: "WIP" })).status).toBe(403);
    expect((await PATCH2("/v1/projects/PLEX", editorToken, { name: "X" })).status).toBe(403);
  });

  test("project admin: config on own project succeeds; other project is 403", async () => {
    const { padminToken } = await seed();
    expect((await PATCH2("/v1/projects/PLEX", padminToken, { name: "Plex2" })).status).toBe(200);
    expect((await POST("/v1/projects/PLEX/statuses", padminToken, { category: "in_progress", display_name: "WIP" })).status).toBe(201);
    // Not a member of SWY → 403 (writes), even though the token has projects:manage.
    expect((await PATCH2("/v1/projects/SWY", padminToken, { name: "X" })).status).toBe(403);
    expect((await POST("/v1/projects/SWY/statuses", padminToken, { category: "in_progress", display_name: "WIP" })).status).toBe(403);
  });

  test("instance surfaces gate on instance role: project admin → 403; project create is instance-only", async () => {
    const { ctx, padminToken, ownerToken } = await seed();
    expect((await POST("/v1/rules", padminToken, RULE)).status).toBe(403);
    expect((await POST("/v1/labels", padminToken, { name: "l", color: "#abcdef" })).status).toBe(403);
    expect((await POST("/v1/boards", padminToken, { name: "b", project_ids: [ctx.plex.id] })).status).toBe(403);
    expect((await POST("/v1/users", padminToken, { name: "u", type: "human" })).status).toBe(403);
    expect((await PATCH2("/v1/settings", padminToken, { stale_in_progress_days: 14 })).status).toBe(403);
    // projects.create is instance-level — a project admin cannot mint projects.
    expect((await POST("/v1/projects", padminToken, { key: "NEW", name: "New" })).status).toBe(403);
    expect((await POST("/v1/projects", ownerToken, { key: "NEW", name: "New" })).status).toBe(201);
  });

  test("cross-project move requires write on BOTH ends", async () => {
    const { editorToken, ownerToken } = await seed();
    // editor is write on PLEX but not a member of SWY → blocked on the destination.
    expect((await POST("/v1/tickets/PLEX-1/move", editorToken, { project_key: "SWY" })).status).toBe(403);
    // owner bypasses → move succeeds.
    expect((await POST("/v1/tickets/PLEX-1/move", ownerToken, { project_key: "SWY" })).status).toBe(200);
  });

  test("templates are editor-tier: editor 201, viewer 403", async () => {
    const { editorToken, friendToken } = await seed();
    const tpl = { title: "T", type: "task", trigger_at: "2027-01-01T00:00:00.000Z" };
    expect((await POST("/v1/projects/PLEX/templates", editorToken, tpl)).status).toBe(201);
    expect((await POST("/v1/projects/PLEX/templates", friendToken, tpl)).status).toBe(403);
  });

  test("regression: owner + agent retain full write access", async () => {
    const { ownerToken, agentToken } = await seed();
    // Owner (admin token) writes anywhere, including project config + instance surfaces.
    expect((await POST("/v1/tickets", ownerToken, { project_key: "SWY", type: "task", title: "o" })).status).toBe(201);
    expect((await POST("/v1/projects/PLEX/statuses", ownerToken, { category: "in_progress", display_name: "WIP" })).status).toBe(201);
    expect((await POST("/v1/rules", ownerToken, RULE)).status).toBe(201);
    // Agent (plain tickets:write token) bypasses project membership — imperium-loop stays unbroken.
    expect((await POST("/v1/tickets", agentToken, { project_key: "SWY", type: "task", title: "a" })).status).toBe(201);
  });
});

// ─── SWY-163 — author-scoped ticket delete (real HTTP) ───────────────────────
// `delete` is split out of `write`: a `user` role writes but may delete only
// tickets it reported; an `editor` (delete-capable) deletes any; a `viewer`
// none. All tokens carry tickets:write so the ROLE gate — not the scope — is
// what draws the line (assertCanDelete). Owners/agents bypass as always.
describe("SWY-163 — author-scoped ticket delete (HTTP)", () => {
  async function seed() {
    const ctx = await fixture();
    const [collab] = await testDb.insert(schema.users)
      .values({ name: "collab", type: "human", instance_role: "member" }).returning();
    await testDb.insert(schema.userProjects).values({ user_id: collab!.id, project_id: ctx.plex.id, role: "user" });
    const [editor] = await testDb.insert(schema.users)
      .values({ name: "editor", type: "human", instance_role: "member" }).returning();
    await testDb.insert(schema.userProjects).values({ user_id: editor!.id, project_id: ctx.plex.id, role: "editor" });

    // PLEX-1 reported by collab (their own); PLEX-2, PLEX-3 reported by magos.
    const mk = (number: number, reporter_id: string) =>
      testDb.insert(schema.tickets).values({
        project_id: ctx.plex.id, number, type: "task", title: `T-${number}`,
        status_id: ctx.plexBacklog.id, reporter_id,
      }).returning().then((r) => r[0]!);
    await mk(1, collab!.id);
    await mk(2, ctx.magos.id);
    await mk(3, ctx.magos.id);
    await testDb.update(schema.projectCounters).set({ last_used_number: 3 })
      .where(inArray(schema.projectCounters.project_id, [ctx.plex.id]));

    return {
      ctx,
      collabToken: await mintToken(collab!.id, ["tickets:write"]),
      editorToken: await mintToken(editor!.id, ["tickets:write"]),
      friendToken: await mintToken(ctx.friend.id, ["tickets:write"]),
    };
  }

  test("a `user` deletes its OWN reported ticket (204) but not another's (403)", async () => {
    const { collabToken } = await seed();
    expect((await DELETE("/v1/tickets/PLEX-1", collabToken)).status).toBe(204); // own
    expect((await DELETE("/v1/tickets/PLEX-2", collabToken)).status).toBe(403); // magos'
  });

  test("an editor deletes any ticket, including ones it didn't report (204)", async () => {
    const { editorToken } = await seed();
    expect((await DELETE("/v1/tickets/PLEX-3", editorToken)).status).toBe(204);
  });

  test("a viewer cannot delete even a ticket in its own project (403)", async () => {
    const { friendToken } = await seed();
    // friend is a viewer on PLEX (fixture) — no delete, not the author.
    expect((await DELETE("/v1/tickets/PLEX-2", friendToken)).status).toBe(403);
  });
});

// 6.3 / SWY-74 — read-only (dashboard) tokens. Creation is read-only-by-
// construction (scopes capped server-side); a minted dashboard token then reads
// but can't write, proving it converges on the same read-only path as a viewer.
describe("6.3 — read-only (dashboard) tokens (HTTP)", () => {
  test("dashboard token mints with the read-only bundle when no scopes are given", async () => {
    const ctx = await fixture();
    const ownerToken = await mintToken(ctx.magos.id, ["admin"]);
    const res = await POST(`/v1/users/${ctx.magos.id}/tokens`, ownerToken, {
      name: "demo-board",
      kind: "dashboard",
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as { kind: string; scopes: string[]; token: string };
    expect(json.kind).toBe("dashboard");
    expect(json.scopes).toEqual(["tickets:read"]);
    expect(json.token).toBeTruthy();
  });

  test("a write scope on a dashboard token is rejected 400 invalid_scopes_for_kind", async () => {
    const ctx = await fixture();
    const ownerToken = await mintToken(ctx.magos.id, ["admin"]);
    const res = await POST(`/v1/users/${ctx.magos.id}/tokens`, ownerToken, {
      name: "bad-dash",
      kind: "dashboard",
      scopes: ["tickets:read", "tickets:write"],
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: { code: string; details?: { reason?: string } } };
    expect(json.error.code).toBe("bad_request");
    expect(json.error.details?.reason).toBe("invalid_scopes_for_kind");
  });

  test("a personal token keeps its requested scopes and personal kind", async () => {
    const ctx = await fixture();
    const ownerToken = await mintToken(ctx.magos.id, ["admin"]);
    const res = await POST(`/v1/users/${ctx.magos.id}/tokens`, ownerToken, {
      name: "agent-key",
      scopes: ["tickets:read", "tickets:write"],
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as { kind: string; scopes: string[] };
    expect(json.kind).toBe("personal");
    expect(json.scopes).toEqual(["tickets:read", "tickets:write"]);
  });

  test("a minted dashboard token reads but cannot write (converges on read-only)", async () => {
    const ctx = await fixture();
    const ownerToken = await mintToken(ctx.magos.id, ["admin"]);
    // Seed a ticket the dashboard token can read.
    const created = await POST("/v1/tickets", ownerToken, { project_key: "SWY", type: "task", title: "visible" });
    expect(created.status).toBe(201);
    const ticketKey = ((await created.json()) as { key: string }).key;

    // Mint a dashboard token on the agent so it can read across projects.
    const mintRes = await POST(`/v1/users/${ctx.claude.id}/tokens`, ownerToken, {
      name: "public-dash",
      kind: "dashboard",
    });
    const dashToken = ((await mintRes.json()) as { token: string }).token;

    // Reads work…
    expect((await GET(`/v1/tickets/${ticketKey}`, dashToken)).status).toBe(200);
    // …writes are blocked by the token-scope gate (no tickets:write) → 403.
    expect((await POST("/v1/tickets", dashToken, { project_key: "SWY", type: "task", title: "nope" })).status).toBe(403);
  });
});

// 6.4 / SWY-103 — membership CRUD + instance-role admin. Membership management
// is project-admin (+ owner/agent) only: roster reads 404 for non-members
// (existence hiding) and 403 for member-but-not-admin; writes gate on the
// `manage` role + `projects:manage` token scope. Tokens carry BROAD so each
// test proves the ROLE gate blocks even when the TOKEN would allow it.
describe("6.4 — membership & invite (HTTP)", () => {
  const BROAD = ["projects:manage", "users:manage"];

  async function seed() {
    const ctx = await fixture();
    const [editor] = await testDb.insert(schema.users)
      .values({ name: "editor", type: "human", instance_role: "member" }).returning();
    await testDb.insert(schema.userProjects).values({ user_id: editor!.id, project_id: ctx.plex.id, role: "editor" });
    const [padmin] = await testDb.insert(schema.users)
      .values({ name: "padmin", type: "human", instance_role: "member" }).returning();
    await testDb.insert(schema.userProjects).values({ user_id: padmin!.id, project_id: ctx.plex.id, role: "admin" });
    // `stranger` belongs to no project; `newbie` is the user we add/remove.
    const [stranger] = await testDb.insert(schema.users)
      .values({ name: "stranger", type: "human", instance_role: "member" }).returning();
    const [newbie] = await testDb.insert(schema.users)
      .values({ name: "newbie", type: "human", instance_role: "member" }).returning();
    return {
      ctx, newbie: newbie!,
      friendToken: await mintToken(ctx.friend.id, BROAD),
      editorToken: await mintToken(editor!.id, BROAD),
      padminToken: await mintToken(padmin!.id, BROAD),
      strangerToken: await mintToken(stranger!.id, BROAD),
      ownerToken: await mintToken(ctx.magos.id, ["admin"]),
      agentToken: await mintToken(ctx.claude.id, ["admin"]),
    };
  }

  test("owner: full member CRUD on any project", async () => {
    const { newbie, ownerToken } = await seed();
    expect((await POST("/v1/projects/SWY/members", ownerToken, { user_id: newbie.id, role: "viewer" })).status).toBe(201);
    const listed = await GET("/v1/projects/SWY/members", ownerToken);
    expect(listed.status).toBe(200);
    expect(((await listed.json()) as any).items.some((m: any) => m.user.id === newbie.id && m.role === "viewer")).toBe(true);
    expect((await PATCH2(`/v1/projects/SWY/members/${newbie.id}`, ownerToken, { role: "editor" })).status).toBe(200);
    expect((await DELETE(`/v1/projects/SWY/members/${newbie.id}`, ownerToken)).status).toBe(204);
  });

  test("agent (instance-wide) can manage members too", async () => {
    const { newbie, agentToken } = await seed();
    expect((await POST("/v1/projects/PLEX/members", agentToken, { user_id: newbie.id, role: "viewer" })).status).toBe(201);
  });

  test("project admin: manages own project's members; 403 writes / 404 reads on another", async () => {
    const { newbie, padminToken } = await seed();
    expect((await POST("/v1/projects/PLEX/members", padminToken, { user_id: newbie.id, role: "viewer" })).status).toBe(201);
    expect((await GET("/v1/projects/PLEX/members", padminToken)).status).toBe(200);
    expect((await PATCH2(`/v1/projects/PLEX/members/${newbie.id}`, padminToken, { role: "editor" })).status).toBe(200);
    expect((await DELETE(`/v1/projects/PLEX/members/${newbie.id}`, padminToken)).status).toBe(204);
    // Not a member of SWY → writes 403, reads 404 (existence hiding) even with projects:manage.
    expect((await POST("/v1/projects/SWY/members", padminToken, { user_id: newbie.id, role: "viewer" })).status).toBe(403);
    expect((await GET("/v1/projects/SWY/members", padminToken)).status).toBe(404);
  });

  test("editor + viewer members: roster is admin-only (403), no writes", async () => {
    const { newbie, editorToken, friendToken } = await seed();
    // Members of PLEX → 403 (admin-only), NOT 404 (they can see the project exists).
    expect((await GET("/v1/projects/PLEX/members", editorToken)).status).toBe(403);
    expect((await GET("/v1/projects/PLEX/members", friendToken)).status).toBe(403);
    expect((await POST("/v1/projects/PLEX/members", editorToken, { user_id: newbie.id, role: "viewer" })).status).toBe(403);
    expect((await POST("/v1/projects/PLEX/members", friendToken, { user_id: newbie.id, role: "viewer" })).status).toBe(403);
  });

  test("non-member: roster 404 (existence hiding)", async () => {
    const { strangerToken } = await seed();
    expect((await GET("/v1/projects/PLEX/members", strangerToken)).status).toBe(404);
  });

  test("duplicate add → 409; unknown user → 404", async () => {
    const { ctx, ownerToken } = await seed();
    // friend is already a viewer on PLEX (from fixture).
    expect((await POST("/v1/projects/PLEX/members", ownerToken, { user_id: ctx.friend.id, role: "viewer" })).status).toBe(409);
    expect((await POST("/v1/projects/PLEX/members", ownerToken, { user_id: "00000000-0000-0000-0000-000000000000", role: "viewer" })).status).toBe(404);
  });

  test("instance_role: owner can promote; demotion allowed once a second owner exists", async () => {
    const { ctx, newbie, ownerToken } = await seed();
    expect((await PATCH2(`/v1/users/${newbie.id}`, ownerToken, { instance_role: "owner" })).status).toBe(200);
    // Two owners now → demoting magos is allowed (this is the last action in the test).
    expect((await PATCH2(`/v1/users/${ctx.magos.id}`, ownerToken, { instance_role: "member" })).status).toBe(200);
  });

  test("last-owner guard: demoting the sole owner → 422", async () => {
    const { ctx, ownerToken } = await seed();
    expect((await PATCH2(`/v1/users/${ctx.magos.id}`, ownerToken, { instance_role: "member" })).status).toBe(422);
  });
});

// ─── 6.5 — agent service-account hardening (SWY-104) ──────────────────────────
//
// The agent bypass must be deliberate and verified, not accidental. These tests
// pin the acceptance: every imperium-loop per-actor token reads + writes across
// MULTIPLE projects with ZERO membership rows — agent-ness alone (the single
// `hasInstanceWideAccess` predicate) carries instance-wide access. A regression
// on any one actor — or anything that quietly starts requiring membership for
// agents — fails the build here. Drives the real Hono app over HTTP.
const IMPERIUM_ACTORS = [
  "claude", "n8n-cogitation", "n8n-vox-dictate",
  "servo-signal", "autosavant-bot", "rules-engine",
] as const;

describe("6.5 — agent service accounts (instance-wide, no membership rows)", () => {
  // Two projects (PLEX + SWY from the fixture), each with a backlog +
  // in_progress status and a seed ticket, plus the full imperium-loop roster as
  // agents. None of them get a `user_projects` row.
  async function seed() {
    const ctx = await fixture(); // seeds `claude` already
    const agents: Record<string, { id: string }> = { claude: ctx.claude };
    for (const name of IMPERIUM_ACTORS) {
      if (name === "claude") continue;
      const [u] = await testDb
        .insert(schema.users)
        .values({ name, type: "agent", instance_role: "member" })
        .returning();
      agents[name] = u!;
    }
    // A second status per project so a transition has somewhere to go.
    const mkStatus = (project: { id: string }, name: string) =>
      testDb
        .insert(schema.statuses)
        .values({ project_id: project.id, category: "in_progress", display_name: name, position: 1 })
        .returning()
        .then((r) => r[0]!);
    const plexWip = await mkStatus(ctx.plex, "WIP");
    const swyWip = await mkStatus(ctx.swy, "WIP");
    // One ticket per project as the read/comment/transition target.
    const mkTicket = (project: { id: string }, status: { id: string }, title: string) =>
      testDb
        .insert(schema.tickets)
        .values({ project_id: project.id, number: 1, type: "task", title, status_id: status.id, reporter_id: ctx.magos.id })
        .returning()
        .then((r) => r[0]!);
    await mkTicket(ctx.plex, ctx.plexBacklog, "Plex seed");
    await mkTicket(ctx.swy, ctx.swyBacklog, "Swy seed");
    // Manually-numbered seed rows must advance the counter so POST-create
    // allocations don't collide on (project_id, number).
    await testDb
      .update(schema.projectCounters)
      .set({ last_used_number: 1 })
      .where(inArray(schema.projectCounters.project_id, [ctx.plex.id, ctx.swy.id]));
    return { ctx, agents, plexWip: plexWip!, swyWip: swyWip! };
  }

  test("no imperium-loop actor holds any membership row (exempt from user_projects)", async () => {
    const { agents } = await seed();
    const ids = Object.values(agents).map((a) => a.id);
    const rows = await testDb
      .select()
      .from(schema.userProjects)
      .where(inArray(schema.userProjects.user_id, ids));
    expect(rows).toHaveLength(0);
  });

  // The core acceptance, table-driven over the full actor roster: each per-actor
  // token reads + writes (create / comment / transition) across BOTH projects.
  for (const name of IMPERIUM_ACTORS) {
    test(`${name}: reads + writes cross-project (PLEX + SWY) with no membership`, async () => {
      const { agents, plexWip, swyWip } = await seed();
      const token = await mintToken(agents[name]!.id, ["tickets:write", "comments:write"]);

      // READ a ticket in each project.
      expect((await GET("/v1/tickets/PLEX-1", token)).status).toBe(200);
      expect((await GET("/v1/tickets/SWY-1", token)).status).toBe(200);

      // CREATE a ticket in each project.
      expect((await POST("/v1/tickets", token, { project_key: "PLEX", type: "task", title: "by agent" })).status).toBe(201);
      expect((await POST("/v1/tickets", token, { project_key: "SWY", type: "task", title: "by agent" })).status).toBe(201);

      // COMMENT on a ticket in each project.
      expect((await POST("/v1/tickets/PLEX-1/comments", token, { body: "agent note" })).status).toBe(201);
      expect((await POST("/v1/tickets/SWY-1/comments", token, { body: "agent note" })).status).toBe(201);

      // TRANSITION a ticket in each project (backlog → in_progress; no resolution).
      expect((await POST("/v1/tickets/PLEX-1/transition", token, { status_id: plexWip.id })).status).toBe(200);
      expect((await POST("/v1/tickets/SWY-1/transition", token, { status_id: swyWip.id })).status).toBe(200);
    });
  }
});

// ─── 7.0 — plan reads (SWY-109) ──────────────────────────────────────────────
// Plans inherit their ticket's project membership. The friend (viewer on PLEX
// only) reads the PLEX plan but gets 404 on every SWY plan read — existence
// stays hidden — and 403 when trying to submit on a project they can't write.
describe("7.0 — plan reads + write isolation (HTTP, friend=viewer on PLEX)", () => {
  async function seed() {
    const ctx = await fixture();
    const mkTicket = async (project: { id: string }, status: { id: string }, number: number) => {
      const [t] = await testDb.insert(schema.tickets).values({
        project_id: project.id, number, type: "task", title: `T-${number}`,
        status_id: status.id, reporter_id: ctx.magos.id,
      }).returning();
      return t!;
    };
    await mkTicket(ctx.plex, ctx.plexBacklog, 1);
    await mkTicket(ctx.swy, ctx.swyBacklog, 1);

    const ownerToken = await mintToken(ctx.magos.id, ["admin"]);
    const friendToken = await mintToken(ctx.friend.id, ["tickets:write"]);

    // Owner (instance-wide) seeds a plan on a ticket in each project.
    const submit = (key: string) =>
      POST(`/v1/tickets/${key}/plan/revisions`, ownerToken, {
        narrative_md: "plan", criteria: [{ text: "x" }],
      });
    expect((await submit("PLEX-1")).status).toBe(201);
    expect((await submit("SWY-1")).status).toBe(201);
    return { friendToken };
  }

  test("PLEX plan reads resolve; SWY plan reads 404 (not 403)", async () => {
    const { friendToken } = await seed();
    expect((await GET("/v1/tickets/PLEX-1/plan", friendToken)).status).toBe(200);
    expect((await GET("/v1/tickets/PLEX-1/plan/revisions", friendToken)).status).toBe(200);
    expect((await GET("/v1/tickets/PLEX-1/plan/revisions/1", friendToken)).status).toBe(200);

    for (const path of ["/v1/tickets/SWY-1/plan", "/v1/tickets/SWY-1/plan/revisions", "/v1/tickets/SWY-1/plan/revisions/1"]) {
      const res = await GET(path, friendToken);
      expect(res.status).toBe(404);
      expect((await res.json()).error.code).toBe("not_found");
    }
  });

  test("viewer cannot submit/review on PLEX (403); non-member write on SWY (403)", async () => {
    const { friendToken } = await seed();
    // Viewer role on PLEX → 403 on writes despite a tickets:write token.
    expect((await POST("/v1/tickets/PLEX-1/plan/revisions", friendToken, {
      narrative_md: "n", criteria: [{ text: "x" }],
    })).status).toBe(403);
    expect((await POST("/v1/tickets/PLEX-1/plan/revisions/1/review", friendToken, {
      verdict: "approved",
    })).status).toBe(403);
    // Non-member project write on SWY → 403 (the actor named the resource by key).
    expect((await POST("/v1/tickets/SWY-1/plan/revisions", friendToken, {
      narrative_md: "n", criteria: [{ text: "x" }],
    })).status).toBe(403);
  });
});
