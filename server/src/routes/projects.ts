import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import {
  Project, CreateProject, UpdateProject,
  ProjectKey, paginated, Pagination,
} from "@switchyard/shared";
import { requireAuth } from "../auth.js";
import { errorResponses, okJson, createdJson, noContent, stub, z } from "./_helpers.js";

const tag = "Projects";

const list = createRoute({
  method: "get", path: "/v1/projects", tags: [tag], summary: "List projects",
  request: { query: Pagination.extend({ include_archived: z.coerce.boolean().default(false) }) },
  responses: { ...okJson(paginated(Project)), ...errorResponses },
});

const create = createRoute({
  method: "post", path: "/v1/projects", tags: [tag], summary: "Create a project",
  request: { body: { content: { "application/json": { schema: CreateProject } } } },
  responses: { ...createdJson(Project), ...errorResponses },
});

const get = createRoute({
  method: "get", path: "/v1/projects/{key}", tags: [tag], summary: "Get a project",
  request: { params: z.object({ key: ProjectKey }) },
  responses: { ...okJson(Project), ...errorResponses },
});

const update = createRoute({
  method: "patch", path: "/v1/projects/{key}", tags: [tag], summary: "Update a project (key is immutable)",
  request: {
    params: z.object({ key: ProjectKey }),
    body: { content: { "application/json": { schema: UpdateProject } } },
  },
  responses: { ...okJson(Project), ...errorResponses },
});

const remove = createRoute({
  method: "delete", path: "/v1/projects/{key}", tags: [tag], summary: "Soft-delete a project",
  request: { params: z.object({ key: ProjectKey }) },
  responses: { ...noContent, ...errorResponses },
});

export function mount(app: OpenAPIHono) {
  app.use("/v1/projects/*", requireAuth);
  app.openapi(list, stub);
  app.openapi(create, stub);
  app.openapi(get, stub);
  app.openapi(update, stub);
  app.openapi(remove, stub);
}
