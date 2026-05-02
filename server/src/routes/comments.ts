import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { Comment, CreateComment, UpdateComment, Uuid, paginated, Pagination } from "@switchyard/shared";
import { requireAuth } from "../auth.js";
import { errorResponses, okJson, createdJson, noContent, stub, z, idempotencyHeader } from "./_helpers.js";

const tag = "Comments";
const idOrKey = z.string().min(1);

const list = createRoute({
  method: "get", path: "/v1/tickets/{idOrKey}/comments", tags: [tag], summary: "List comments on a ticket",
  request: { params: z.object({ idOrKey }), query: Pagination },
  responses: { ...okJson(paginated(Comment)), ...errorResponses },
});

const create = createRoute({
  method: "post", path: "/v1/tickets/{idOrKey}/comments", tags: [tag], summary: "Create a comment",
  request: {
    params: z.object({ idOrKey }),
    headers: idempotencyHeader,
    body: { content: { "application/json": { schema: CreateComment } } },
  },
  responses: { ...createdJson(Comment), ...errorResponses },
});

const update = createRoute({
  method: "patch", path: "/v1/comments/{id}", tags: [tag], summary: "Update a comment",
  request: {
    params: z.object({ id: Uuid }),
    body: { content: { "application/json": { schema: UpdateComment } } },
  },
  responses: { ...okJson(Comment), ...errorResponses },
});

const remove = createRoute({
  method: "delete", path: "/v1/comments/{id}", tags: [tag], summary: "Soft-delete a comment",
  request: { params: z.object({ id: Uuid }) },
  responses: { ...noContent, ...errorResponses },
});

export function mount(app: OpenAPIHono) {
  app.use("/v1/comments/*", requireAuth);
  app.openapi(list, stub);
  app.openapi(create, stub);
  app.openapi(update, stub);
  app.openapi(remove, stub);
}
