import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { and, desc, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  Board, CreateBoard, UpdateBoard, BoardColumns,
  Uuid, paginated, Pagination,
  type StatusCategory, type ProjectRef as ApiProjectRef, type BoardFilter as ApiBoardFilter,
} from "@switchyard/shared";
import { db } from "../db.js";
import { DEFAULT_BOARD_DELETED_KEY } from "../lib/defaultBoard.js";
import * as schema from "../../drizzle/schema.js";
import { requireAuth } from "../auth.js";
import { idempotency } from "../lib/idempotency.js";
import { errorResponses, okJson, createdJson, noContent, checkScope, z } from "./_helpers.js";
import { mapTicketSummary, mapProjectRef } from "../lib/mappers.js";
import { fetchExternalRefsByTicket } from "../lib/tickets.js";
import { buildPage, cursorOrderBy, cursorWhere, decodeCursor } from "../lib/pagination.js";
import { badRequest, notFound } from "../errors.js";

const tag = "Boards";
const CATEGORIES: StatusCategory[] = ["backlog", "planning", "in_progress", "blocked", "closed"];

// Map a board row + the bulk-fetched project refs into the API shape.
// Centralized so adding a new board-level field is one edit instead of
// touching every handler.
type BoardRow = typeof schema.boards.$inferSelect;
function shapeBoard(b: BoardRow, projects: ApiProjectRef[]) {
  return {
    id: b.id,
    name: b.name,
    layout: b.layout,
    filter: (b.filter ?? {}) as ApiBoardFilter,
    projects,
    auto_include_all_projects: b.auto_include_all_projects,
    created_at: b.created_at,
    updated_at: b.updated_at,
  };
}

const list = createRoute({
  method: "get", path: "/v1/boards", tags: [tag], summary: "List boards",
  request: { query: Pagination },
  responses: { ...okJson(paginated(Board)), ...errorResponses },
});

const create = createRoute({
  method: "post", path: "/v1/boards", tags: [tag], summary: "Create a board",
  request: { body: { content: { "application/json": { schema: CreateBoard } } } },
  responses: { ...createdJson(Board), ...errorResponses },
});

const get = createRoute({
  method: "get", path: "/v1/boards/{id}", tags: [tag], summary: "Get a board",
  request: { params: z.object({ id: Uuid }) },
  responses: { ...okJson(Board), ...errorResponses },
});

const update = createRoute({
  method: "patch", path: "/v1/boards/{id}", tags: [tag], summary: "Update a board",
  request: {
    params: z.object({ id: Uuid }),
    body: { content: { "application/json": { schema: UpdateBoard } } },
  },
  responses: { ...okJson(Board), ...errorResponses },
});

const remove = createRoute({
  method: "delete", path: "/v1/boards/{id}", tags: [tag], summary: "Delete a board",
  request: { params: z.object({ id: Uuid }) },
  responses: { ...noContent, ...errorResponses },
});

const columns = createRoute({
  method: "get", path: "/v1/boards/{id}/columns", tags: [tag],
  summary: "Tickets grouped by status category for the board's projects (kanban view)",
  request: { params: z.object({ id: Uuid }) },
  responses: { ...okJson(BoardColumns), ...errorResponses },
});

export function mount(app: OpenAPIHono) {
  app.use("/v1/boards/*", requireAuth);
  app.use("/v1/boards/*", idempotency);

  app.openapi(list, (async (c: any) => {
    const q = c.req.valid("query");
    const limit = q.limit;

    const conds: SQL[] = [];
    if (q.cursor) {
      const cur = decodeCursor(q.cursor);
      if (!cur) throw badRequest("invalid cursor");
      conds.push(cursorWhere(schema.boards.updated_at, schema.boards.id, cur));
    }

    const rows = await db.select().from(schema.boards)
      .where(conds.length > 0 ? and(...conds) : undefined)
      .orderBy(...cursorOrderBy(schema.boards.updated_at, schema.boards.id))
      .limit(limit + 1);

    if (rows.length === 0) {
      return c.json({ items: [], page: { next_cursor: null, has_more: false } }, 200);
    }

    // Bulk-fetch project memberships for the boards on this page.
    const projectsByBoard = await fetchBoardProjects(rows.map((b) => b.id));

    const boards = rows.map((b) => shapeBoard(b, projectsByBoard.get(b.id) ?? []));

    return c.json(buildPage(boards, limit), 200);
  }) as any);

  app.openapi(get, (async (c: any) => {
    const { id } = c.req.valid("param");
    const [board] = await db.select().from(schema.boards).where(eq(schema.boards.id, id)).limit(1);
    if (!board) throw notFound("board");
    const projects = (await fetchBoardProjects([board.id])).get(board.id) ?? [];
    return c.json(shapeBoard(board, projects), 200);
  }) as any);

  app.openapi(columns, (async (c: any) => {
    const { id } = c.req.valid("param");
    const [board] = await db.select().from(schema.boards).where(eq(schema.boards.id, id)).limit(1);
    if (!board) throw notFound("board");

    const projectRefs = (await fetchBoardProjects([board.id])).get(board.id) ?? [];
    const projectIds = projectRefs.map((p) => p.id);

    if (projectIds.length === 0) {
      return c.json({
        board: shapeBoard(board, []),
        columns: CATEGORIES.map((category) => ({ category, tickets: [] })),
      }, 200);
    }

    const filter = (board.filter ?? {}) as ApiBoardFilter;
    const conds: SQL[] = [
      inArray(schema.tickets.project_id, projectIds),
      isNull(schema.tickets.deleted_at),
    ];
    if (filter.types && filter.types.length > 0) {
      conds.push(inArray(schema.tickets.type, filter.types as any));
    }
    if (filter.priorities && filter.priorities.length > 0) {
      conds.push(inArray(schema.tickets.priority, filter.priorities as any));
    }
    if (filter.assignee_ids && filter.assignee_ids.length > 0) {
      conds.push(inArray(schema.tickets.assignee_id, filter.assignee_ids));
    }
    if (filter.label_ids && filter.label_ids.length > 0) {
      conds.push(sqlExistsLabels(filter.label_ids));
    }

    const assignee = alias(schema.users, "assignee");
    const reporter = alias(schema.users, "reporter");

    const rows = await db.select({
      t: schema.tickets,
      project: schema.projects,
      status: schema.statuses,
      assignee,
      reporter,
    })
      .from(schema.tickets)
      .innerJoin(schema.projects, eq(schema.tickets.project_id, schema.projects.id))
      .innerJoin(schema.statuses, eq(schema.tickets.status_id, schema.statuses.id))
      .leftJoin(assignee, eq(schema.tickets.assignee_id, assignee.id))
      .innerJoin(reporter, eq(schema.tickets.reporter_id, reporter.id))
      .where(and(...conds))
      // Position-aware default sort: explicit positions win, fall back to
      // updated_at desc for any rows that haven't been manually reordered yet.
      // The board UI relies on this ordering when rendering kanban columns.
      .orderBy(sql`${schema.tickets.position} DESC NULLS LAST`, desc(schema.tickets.updated_at));

    // Bulk-fetch labels.
    const ticketIds = rows.map((r) => r.t.id);
    const labelRows = ticketIds.length > 0
      ? await db.select({
          ticket_id: schema.ticketLabels.ticket_id,
          label: schema.labels,
        })
          .from(schema.ticketLabels)
          .innerJoin(schema.labels, eq(schema.ticketLabels.label_id, schema.labels.id))
          .where(inArray(schema.ticketLabels.ticket_id, ticketIds))
      : [];
    const labelsByTicket = new Map<string, (typeof schema.labels.$inferSelect)[]>();
    for (const r of labelRows) {
      const arr = labelsByTicket.get(r.ticket_id) ?? [];
      arr.push(r.label);
      labelsByTicket.set(r.ticket_id, arr);
    }

    // Batch-resolve parent epics for the fetched tickets (SWY-83).
    const parentIds = [
      ...new Set(
        rows.map((r) => r.t.parent_id).filter((x): x is string => x !== null),
      ),
    ];
    const parentRows = parentIds.length
      ? await db
          .select({
            id: schema.tickets.id,
            number: schema.tickets.number,
            title: schema.tickets.title,
            project_key: schema.projects.key,
          })
          .from(schema.tickets)
          .innerJoin(schema.projects, eq(schema.tickets.project_id, schema.projects.id))
          .where(inArray(schema.tickets.id, parentIds))
      : [];
    const parentsById = new Map(
      parentRows.map(
        (p) =>
          [p.id, { id: p.id, key: `${p.project_key}-${p.number}`, title: p.title }] as const,
      ),
    );

    const refsByTicket = await fetchExternalRefsByTicket(rows.map((r) => r.t.id));

    const summaries = rows.map((r) =>
      mapTicketSummary(r.t, {
        project: r.project,
        status: r.status,
        assignee: r.assignee,
        reporter: r.reporter,
        labels: labelsByTicket.get(r.t.id) ?? [],
        number: r.t.number,
        externalRefs: refsByTicket.get(r.t.id) ?? [],
        parent: r.t.parent_id ? parentsById.get(r.t.parent_id) ?? null : null,
      })
    );

    // Group by canonical category. Empty category arrays are still emitted so
    // the frontend can render placeholder columns.
    const byCategory = new Map<StatusCategory, typeof summaries>();
    for (const cat of CATEGORIES) byCategory.set(cat, []);
    for (const s of summaries) {
      byCategory.get(s.status.category)!.push(s);
    }

    return c.json({
      board: shapeBoard(board, projectRefs),
      columns: CATEGORIES.map((category) => ({
        category,
        tickets: byCategory.get(category) ?? [],
      })),
    }, 200);
  }) as any);

  // ─── create ──────────────────────────────────────────────────────────────
  app.openapi(create, (async (c: any) => {
    checkScope(c, "projects:manage");
    const body = c.req.valid("json");
    if (!body.project_ids || body.project_ids.length === 0) {
      throw badRequest("project_ids must contain at least one project");
    }
    await assertProjectsExist(body.project_ids);

    const created = await db.transaction(async (tx) => {
      const [board] = await tx.insert(schema.boards).values({
        name: body.name,
        layout: body.layout ?? "kanban",
        filter: (body.filter ?? {}) as any,
      }).returning();
      if (!board) throw new Error("board insert returned nothing");

      await tx.insert(schema.boardProjects).values(
        body.project_ids.map((project_id: string) => ({ board_id: board.id, project_id }))
      );

      return board;
    });

    const projects = (await fetchBoardProjects([created.id])).get(created.id) ?? [];
    return c.json(shapeBoard(created, projects), 201);
  }) as any);

  // ─── update ──────────────────────────────────────────────────────────────
  app.openapi(update, (async (c: any) => {
    checkScope(c, "projects:manage");
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");

    const [existing] = await db.select().from(schema.boards).where(eq(schema.boards.id, id)).limit(1);
    if (!existing) throw notFound("board");

    if (body.project_ids !== undefined) {
      if (body.project_ids.length === 0) {
        throw badRequest("project_ids must contain at least one project");
      }
      await assertProjectsExist(body.project_ids);
    }

    const sets: Partial<typeof schema.boards.$inferInsert> = {};
    if (body.name !== undefined) sets.name = body.name;
    if (body.layout !== undefined) sets.layout = body.layout;
    if (body.filter !== undefined) sets.filter = (body.filter ?? {}) as any;

    const noFieldChanges = Object.keys(sets).length === 0;
    const noProjectChange = body.project_ids === undefined;

    const updated = await db.transaction(async (tx) => {
      let row = existing;
      if (!noFieldChanges) {
        const [u] = await tx.update(schema.boards)
          .set(sets)
          .where(eq(schema.boards.id, id))
          .returning();
        if (!u) throw notFound("board");
        row = u;
      }
      if (!noProjectChange) {
        await tx.delete(schema.boardProjects).where(eq(schema.boardProjects.board_id, id));
        await tx.insert(schema.boardProjects).values(
          body.project_ids!.map((project_id: string) => ({ board_id: id, project_id }))
        );
        // Manual project edit on the auto-managed "All projects" board
        // opts out of auto-management: once you touch it, you own it.
        if (existing.auto_include_all_projects) {
          const [flipped] = await tx
            .update(schema.boards)
            .set({ auto_include_all_projects: false })
            .where(eq(schema.boards.id, id))
            .returning();
          if (flipped) row = flipped;
        }
      }
      return row;
    });

    const projects = (await fetchBoardProjects([updated.id])).get(updated.id) ?? [];
    return c.json(shapeBoard(updated, projects), 200);
  }) as any);

  // ─── delete ──────────────────────────────────────────────────────────────
  app.openapi(remove, (async (c: any) => {
    checkScope(c, "projects:manage");
    const { id } = c.req.valid("param");

    await db.transaction(async (tx) => {
      // Capture the board BEFORE deleting so we know whether to set the
      // `default_board_deleted` flag (prevents seed.ts from recreating it
      // on the next boot).
      const [existing] = await tx
        .select({ auto_include: schema.boards.auto_include_all_projects })
        .from(schema.boards)
        .where(eq(schema.boards.id, id))
        .limit(1);
      if (!existing) throw notFound("board");

      // FK on board_projects has ON DELETE CASCADE — the row goes with the board.
      await tx.delete(schema.boards).where(eq(schema.boards.id, id));

      if (existing.auto_include) {
        await tx
          .insert(schema.systemSettings)
          .values({ key: DEFAULT_BOARD_DELETED_KEY, value: true })
          .onConflictDoUpdate({
            target: schema.systemSettings.key,
            set: { value: true, updated_at: new Date().toISOString() },
          });
      }
    });

    return c.body(null, 204);
  }) as any);
}

// Ensure every supplied project id maps to a non-deleted project. Throws 400
// listing the offenders so the agent can fix the input.
async function assertProjectsExist(projectIds: string[]): Promise<void> {
  const found = await db.select({ id: schema.projects.id })
    .from(schema.projects)
    .where(and(
      inArray(schema.projects.id, projectIds),
      isNull(schema.projects.deleted_at),
    ));
  if (found.length === projectIds.length) return;
  const foundSet = new Set(found.map((r) => r.id));
  const missing = projectIds.filter((id) => !foundSet.has(id));
  throw badRequest(`unknown or deleted project_id(s): ${missing.join(", ")}`);
}

// ─── helpers ────────────────────────────────────────────────────────────────

async function fetchBoardProjects(boardIds: string[]): Promise<Map<string, ApiProjectRef[]>> {
  if (boardIds.length === 0) return new Map();
  const rows = await db.select({
    board_id: schema.boardProjects.board_id,
    project: schema.projects,
  })
    .from(schema.boardProjects)
    .innerJoin(schema.projects, eq(schema.boardProjects.project_id, schema.projects.id))
    .where(and(
      inArray(schema.boardProjects.board_id, boardIds),
      isNull(schema.projects.deleted_at),
    ));

  const out = new Map<string, ApiProjectRef[]>();
  for (const r of rows) {
    const arr = out.get(r.board_id) ?? [];
    arr.push(mapProjectRef(r.project));
    out.set(r.board_id, arr);
  }
  return out;
}

function sqlExistsLabels(labelIds: string[]): SQL {
  // labelIds are UUID-validated upstream by Zod, so inline-quoting is safe.
  const arr = labelIds.map((id: string) => `'${id}'`).join(",");
  return sql.raw(
    `EXISTS (SELECT 1 FROM ticket_labels tl WHERE tl.ticket_id = tickets.id AND tl.label_id = ANY(ARRAY[${arr}]::uuid[]))`
  ) as unknown as SQL;
}
