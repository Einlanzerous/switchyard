import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import {
  User, CreateUser, UpdateUser, Uuid,
  ApiToken, CreateApiToken, ApiTokenWithSecret, paginated, Pagination,
} from "@switchyard/shared";
import { requireAuth, requireScope } from "../auth.js";
import { errorResponses, okJson, createdJson, noContent, stub, z } from "./_helpers.js";

const tag = "Users";

const list = createRoute({
  method: "get", path: "/v1/users", tags: [tag], summary: "List users",
  request: { query: Pagination },
  responses: { ...okJson(paginated(User)), ...errorResponses },
});

const create = createRoute({
  method: "post", path: "/v1/users", tags: [tag], summary: "Create a user",
  request: { body: { content: { "application/json": { schema: CreateUser } } } },
  responses: { ...createdJson(User), ...errorResponses },
});

const get = createRoute({
  method: "get", path: "/v1/users/{id}", tags: [tag], summary: "Get a user",
  request: { params: z.object({ id: Uuid }) },
  responses: { ...okJson(User), ...errorResponses },
});

const me = createRoute({
  method: "get", path: "/v1/users/me", tags: [tag], summary: "Get the user owning the current token",
  responses: { ...okJson(User), ...errorResponses },
});

const update = createRoute({
  method: "patch", path: "/v1/users/{id}", tags: [tag], summary: "Update a user",
  request: {
    params: z.object({ id: Uuid }),
    body: { content: { "application/json": { schema: UpdateUser } } },
  },
  responses: { ...okJson(User), ...errorResponses },
});

const remove = createRoute({
  method: "delete", path: "/v1/users/{id}", tags: [tag], summary: "Soft-delete a user",
  request: { params: z.object({ id: Uuid }) },
  responses: { ...noContent, ...errorResponses },
});

const listTokens = createRoute({
  method: "get", path: "/v1/users/{id}/tokens", tags: [tag], summary: "List API tokens for a user",
  request: { params: z.object({ id: Uuid }) },
  responses: { ...okJson(z.object({ items: z.array(ApiToken) })), ...errorResponses },
});

const createToken = createRoute({
  method: "post", path: "/v1/users/{id}/tokens", tags: [tag],
  summary: "Create a new API token (plaintext returned ONCE)",
  request: {
    params: z.object({ id: Uuid }),
    body: { content: { "application/json": { schema: CreateApiToken } } },
  },
  responses: { ...createdJson(ApiTokenWithSecret), ...errorResponses },
});

const revokeToken = createRoute({
  method: "delete", path: "/v1/users/{id}/tokens/{tokenId}", tags: [tag], summary: "Revoke an API token",
  request: { params: z.object({ id: Uuid, tokenId: Uuid }) },
  responses: { ...noContent, ...errorResponses },
});

export function mount(app: OpenAPIHono) {
  app.use("/v1/users/*", requireAuth);
  app.openapi(list, stub);
  app.openapi(me, stub);
  app.openapi(create, requireScope("users:manage"), stub);
  app.openapi(get, stub);
  app.openapi(update, requireScope("users:manage"), stub);
  app.openapi(remove, requireScope("users:manage"), stub);
  app.openapi(listTokens, stub);
  app.openapi(createToken, requireScope("users:manage"), stub);
  app.openapi(revokeToken, requireScope("users:manage"), stub);
}
