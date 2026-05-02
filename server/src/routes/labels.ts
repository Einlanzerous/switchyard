import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { Label, CreateLabel, UpdateLabel, ProjectKey, Uuid } from "@switchyard/shared";
import { errorResponses, okJson, createdJson, noContent, stub, z } from "./_helpers.js";

const tag = "Labels";

const list = createRoute({
  method: "get", path: "/v1/projects/{key}/labels", tags: [tag], summary: "List a project's labels",
  request: { params: z.object({ key: ProjectKey }) },
  responses: { ...okJson(z.object({ items: z.array(Label) })), ...errorResponses },
});

const create = createRoute({
  method: "post", path: "/v1/projects/{key}/labels", tags: [tag], summary: "Create a label",
  request: {
    params: z.object({ key: ProjectKey }),
    body: { content: { "application/json": { schema: CreateLabel } } },
  },
  responses: { ...createdJson(Label), ...errorResponses },
});

const update = createRoute({
  method: "patch", path: "/v1/projects/{key}/labels/{id}", tags: [tag], summary: "Update a label",
  request: {
    params: z.object({ key: ProjectKey, id: Uuid }),
    body: { content: { "application/json": { schema: UpdateLabel } } },
  },
  responses: { ...okJson(Label), ...errorResponses },
});

const remove = createRoute({
  method: "delete", path: "/v1/projects/{key}/labels/{id}", tags: [tag], summary: "Delete a label",
  request: { params: z.object({ key: ProjectKey, id: Uuid }) },
  responses: { ...noContent, ...errorResponses },
});

export function mount(app: OpenAPIHono) {
  app.openapi(list, stub);
  app.openapi(create, stub);
  app.openapi(update, stub);
  app.openapi(remove, stub);
}
