import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { and, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  Board, CreateBoard, UpdateBoard, BoardColumns,
  Uuid, paginated, Pagination,
  type StatusCategory, type ProjectRef as ApiProjectRef, type BoardFilter as ApiBoardFilter,
} from "@switchyard/shared";
import { db } from "../db.js";
import * as schema from "../../drizzle/schema.js";
import { requireAuth } from "../auth.js";
import { idempotency } from "../lib/idempotency.js";
import { errorResponses, okJson, createdJson, noContent, stub, z } from "./_helpers.js";
import { mapTicketSummary, mapProjectRef } from "../lib/mappers.js";
import { buildPage, cursorOrderBy, cursorWhere, decodeCursor } from "../lib/pagination.js";
import { badRequest, notFound } from "../errors.js";

const tag = "Boards";
const CATEGORIES: StatusCategory[] = ["backlog", "planning", "in_progress", "blocked", "closed"];

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

    const boards = rows.map((b) => ({
      id: b.id,
      name: b.name,
      layout: b.layout,
      filter: (b.filter ?? {}) as ApiBoardFilter,
      projects: projectsByBoard.get(b.id) ?? [],
      created_at: b.created_at,
      updated_at: b.updated_at,
    }));

    return c.json(buildPage(boards, limit), 200);
  }) as any);

  app.openapi(get, (async (c: any) => {
    const { id } = c.req.valid("param");
    const [board] = await db.select().from(schema.boards).where(eq(schema.boards.id, id)).limit(1);
    if (!board) throw notFound("board");
    const projects = (await fetchBoardProjects([board.id])).get(board.id) ?? [];
    return c.json({
      id: board.id,
      name: board.name,
      layout: board.layout,
      filter: (board.filter ?? {}) as ApiBoardFilter,
      projects,
      created_at: board.created_at,
      updated_at: board.updated_at,
    }, 200);
  }) as any);

  app.openapi(columns, (async (c: any) => {
    const { id } = c.req.valid("param");
    const [board] = await db.select().from(schema.boards).where(eq(schema.boards.id, id)).limit(1);
    if (!board) throw notFound("board");

    const projectRefs = (await fetchBoardProjects([board.id])).get(board.id) ?? [];
    const projectIds = projectRefs.map((p) => p.id);

    if (projectIds.length === 0) {
      return c.json({
        board: {
          id: board.id, name: board.name, layout: board.layout,
          filter: (board.filter ?? {}) as ApiBoardFilter, projects: [],
          created_at: board.created_at, updated_at: board.updated_at,
        },
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
      .where(and(...conds));

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

    const summaries = rows.map((r) =>
      mapTicketSummary(r.t, {
        project: r.project,
        status: r.status,
        assignee: r.assignee,
        reporter: r.reporter,
        labels: labelsByTicket.get(r.t.id) ?? [],
        number: r.t.number,
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
      board: {
        id: board.id,
        name: board.name,
        layout: board.layout,
        filter,
        projects: projectRefs,
        created_at: board.created_at,
        updated_at: board.updated_at,
      },
      columns: CATEGORIES.map((category) => ({
        category,
        tickets: byCategory.get(category) ?? [],
      })),
    }, 200);
  }) as any);

  app.openapi(create, stub);
  app.openapi(update, stub);
  app.openapi(remove, stub);
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
