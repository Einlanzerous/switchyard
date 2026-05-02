import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import {
  Status, CreateStatus, UpdateStatus, ReorderStatuses,
  StatusTransition, CreateStatusTransition,
  ProjectKey, Uuid,
} from "@switchyard/shared";
import { errorResponses, okJson, createdJson, noContent, stub, z } from "./_helpers.js";

const tag = "Statuses";

const list = createRoute({
  method: "get", path: "/v1/projects/{key}/statuses", tags: [tag], summary: "List a project's statuses",
  request: { params: z.object({ key: ProjectKey }) },
  responses: { ...okJson(z.object({ items: z.array(Status) })), ...errorResponses },
});

const create = createRoute({
  method: "post", path: "/v1/projects/{key}/statuses", tags: [tag], summary: "Create a status",
  request: {
    params: z.object({ key: ProjectKey }),
    body: { content: { "application/json": { schema: CreateStatus } } },
  },
  responses: { ...createdJson(Status), ...errorResponses },
});

const update = createRoute({
  method: "patch", path: "/v1/projects/{key}/statuses/{id}", tags: [tag], summary: "Update a status",
  request: {
    params: z.object({ key: ProjectKey, id: Uuid }),
    body: { content: { "application/json": { schema: UpdateStatus } } },
  },
  responses: { ...okJson(Status), ...errorResponses },
});

const remove = createRoute({
  method: "delete", path: "/v1/projects/{key}/statuses/{id}", tags: [tag], summary: "Delete a status (must be unused)",
  request: { params: z.object({ key: ProjectKey, id: Uuid }) },
  responses: { ...noContent, ...errorResponses },
});

const reorder = createRoute({
  method: "post", path: "/v1/projects/{key}/statuses/reorder", tags: [tag], summary: "Reorder statuses",
  request: {
    params: z.object({ key: ProjectKey }),
    body: { content: { "application/json": { schema: ReorderStatuses } } },
  },
  responses: { ...okJson(z.object({ items: z.array(Status) })), ...errorResponses },
});

const listTransitions = createRoute({
  method: "get", path: "/v1/projects/{key}/transitions", tags: [tag], summary: "List allowed status transitions",
  request: { params: z.object({ key: ProjectKey }) },
  responses: { ...okJson(z.object({ items: z.array(StatusTransition) })), ...errorResponses },
});

const createTransition = createRoute({
  method: "post", path: "/v1/projects/{key}/transitions", tags: [tag], summary: "Allow a status transition",
  request: {
    params: z.object({ key: ProjectKey }),
    body: { content: { "application/json": { schema: CreateStatusTransition } } },
  },
  responses: { ...createdJson(StatusTransition), ...errorResponses },
});

const removeTransition = createRoute({
  method: "delete", path: "/v1/projects/{key}/transitions/{id}", tags: [tag], summary: "Remove a transition rule",
  request: { params: z.object({ key: ProjectKey, id: Uuid }) },
  responses: { ...noContent, ...errorResponses },
});

export function mount(app: OpenAPIHono) {
  app.openapi(list, stub);
  app.openapi(create, stub);
  app.openapi(update, stub);
  app.openapi(remove, stub);
  app.openapi(reorder, stub);
  app.openapi(listTransitions, stub);
  app.openapi(createTransition, stub);
  app.openapi(removeTransition, stub);
}
