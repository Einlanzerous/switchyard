import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { and, desc, eq, isNull, type SQL } from "drizzle-orm";
import {
  User, CreateUser, UpdateUser, Uuid,
  ApiToken, CreateApiToken, ApiTokenWithSecret, paginated, Pagination,
} from "@switchyard/shared";
import { db } from "../db.js";
import * as schema from "../../drizzle/schema.js";
import { requireAuth } from "../auth.js";
import { idempotency } from "../lib/idempotency.js";
import { errorResponses, okJson, createdJson, noContent, z, checkScope } from "./_helpers.js";
import { mapUser, mapApiToken } from "../lib/mappers.js";
import { getUserById } from "../lib/lookups.js";
import { buildPage, cursorOrderBy, cursorWhere, decodeCursor } from "../lib/pagination.js";
import { generateApiToken } from "../lib/id.js";
import { badRequest, catchUnique, notFound } from "../errors.js";

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
  app.use("/v1/users/*", idempotency);

  app.openapi(list, (async (c: any) => {
    const q = c.req.valid("query");
    const limit = q.limit;
    const conds: SQL[] = [isNull(schema.users.deleted_at)];
    if (q.cursor) {
      const cur = decodeCursor(q.cursor);
      if (!cur) throw badRequest("invalid cursor");
      conds.push(cursorWhere(schema.users.updated_at, schema.users.id, cur));
    }
    const rows = await db.select().from(schema.users)
      .where(and(...conds))
      .orderBy(...cursorOrderBy(schema.users.updated_at, schema.users.id))
      .limit(limit + 1);
    return c.json(buildPage(rows.map(mapUser), limit), 200);
  }) as any);

  app.openapi(me, (async (c: any) => {
    const auth = c.get("auth");
    return c.json(mapUser(auth.user), 200);
  }) as any);

  app.openapi(get, (async (c: any) => {
    const { id } = c.req.valid("param");
    const u = await getUserById(id);
    return c.json(mapUser(u), 200);
  }) as any);

  app.openapi(create, (async (c: any) => {
    checkScope(c, "users:manage");
    const body = c.req.valid("json");
    const [created] = await catchUnique(`user "${body.name}" already exists`, () =>
      db.insert(schema.users).values({
        name: body.name,
        type: body.type,
        icon: body.icon ?? null,
      }).returning()
    );
    if (!created) throw new Error("insert returned nothing");
    return c.json(mapUser(created), 201);
  }) as any);

  app.openapi(update, (async (c: any) => {
    checkScope(c, "users:manage");
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    await getUserById(id);

    const sets: Partial<typeof schema.users.$inferInsert> = {};
    if (body.name !== undefined) sets.name = body.name;
    if (body.type !== undefined) sets.type = body.type;
    if (body.icon !== undefined) sets.icon = body.icon ?? null;

    if (Object.keys(sets).length === 0) {
      const u = await getUserById(id);
      return c.json(mapUser(u), 200);
    }

    const [updated] = await catchUnique("name already in use", () =>
      db.update(schema.users)
        .set(sets)
        .where(eq(schema.users.id, id))
        .returning()
    );
    if (!updated) throw notFound("user");
    return c.json(mapUser(updated), 200);
  }) as any);

  app.openapi(remove, (async (c: any) => {
    checkScope(c, "users:manage");
    const { id } = c.req.valid("param");
    await getUserById(id);
    await db.update(schema.users)
      .set({ deleted_at: new Date().toISOString() })
      .where(eq(schema.users.id, id));
    return c.body(null, 204);
  }) as any);

  app.openapi(listTokens, (async (c: any) => {
    const { id } = c.req.valid("param");
    await getUserById(id);
    const rows = await db.select().from(schema.apiTokens)
      .where(eq(schema.apiTokens.user_id, id))
      .orderBy(desc(schema.apiTokens.created_at));
    return c.json({ items: rows.map(mapApiToken) }, 200);
  }) as any);

  app.openapi(createToken, (async (c: any) => {
    checkScope(c, "users:manage");
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    await getUserById(id);

    const { token, hash, prefix } = generateApiToken();
    const [created] = await db.insert(schema.apiTokens).values({
      user_id: id,
      name: body.name,
      hashed_token: hash,
      token_prefix: prefix,
      scopes: body.scopes,
    }).returning();
    if (!created) throw new Error("insert returned nothing");

    return c.json({ ...mapApiToken(created), token }, 201);
  }) as any);

  app.openapi(revokeToken, (async (c: any) => {
    checkScope(c, "users:manage");
    const { id, tokenId } = c.req.valid("param");
    const [updated] = await db.update(schema.apiTokens)
      .set({ revoked_at: new Date().toISOString() })
      .where(and(
        eq(schema.apiTokens.id, tokenId),
        eq(schema.apiTokens.user_id, id),
      ))
      .returning();
    if (!updated) throw notFound("token");
    return c.body(null, 204);
  }) as any);
}
