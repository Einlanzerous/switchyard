import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import {
  Board, CreateBoard, UpdateBoard, BoardColumns,
  Uuid, paginated, Pagination,
} from "@switchyard/shared";
import { requireAuth } from "../auth.js";
import { errorResponses, okJson, createdJson, noContent, stub, z } from "./_helpers.js";

const tag = "Boards";

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
  app.openapi(list, stub);
  app.openapi(create, stub);
  app.openapi(get, stub);
  app.openapi(update, stub);
  app.openapi(remove, stub);
  app.openapi(columns, stub);
}
