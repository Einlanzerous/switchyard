// Saved views — named filter combinations on the tickets list.
//
// Personal views are owner-only; shared views are visible to everyone but
// only the owner can edit/delete. Filter shape is opaque to the server —
// we just store the JSON the client sent and hand it back unchanged. The
// client's URL-filter composable is the source of truth for legal values.

import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { and, asc, eq, or } from "drizzle-orm";
import {
  SavedView, CreateSavedView, UpdateSavedView, Uuid,
  type SavedViewScope as ApiSavedViewScope,
  type SavedViewFilters as ApiSavedViewFilters,
} from "@switchyard/shared";
import { db } from "../db.js";
import * as schema from "../../drizzle/schema.js";
import { requireAuth } from "../auth.js";
import { idempotency } from "../lib/idempotency.js";
import { errorResponses, okJson, createdJson, noContent, z } from "./_helpers.js";
import { mapUserRef } from "../lib/mappers.js";
import { catchUnique, forbidden, notFound } from "../errors.js";

const tag = "Saved Views";

const list = createRoute({
  method: "get", path: "/v1/views", tags: [tag],
  summary: "List saved views (owned + all shared)",
  responses: { ...okJson(z.object({ items: z.array(SavedView) })), ...errorResponses },
});

const create = createRoute({
  method: "post", path: "/v1/views", tags: [tag], summary: "Create a saved view",
  request: { body: { content: { "application/json": { schema: CreateSavedView } } } },
  responses: { ...createdJson(SavedView), ...errorResponses },
});

const update = createRoute({
  method: "patch", path: "/v1/views/{id}", tags: [tag], summary: "Update a saved view (owner only)",
  request: {
    params: z.object({ id: Uuid }),
    body: { content: { "application/json": { schema: UpdateSavedView } } },
  },
  responses: { ...okJson(SavedView), ...errorResponses },
});

const remove = createRoute({
  method: "delete", path: "/v1/views/{id}", tags: [tag], summary: "Delete a saved view (owner only)",
  request: { params: z.object({ id: Uuid }) },
  responses: { ...noContent, ...errorResponses },
});

type ViewRow = typeof schema.savedViews.$inferSelect;
type UserRow = typeof schema.users.$inferSelect;

function mapView(row: ViewRow, owner: UserRow): typeof SavedView._type {
  return {
    id: row.id,
    name: row.name,
    owner: mapUserRef(owner),
    scope: row.scope as ApiSavedViewScope,
    filters: (row.filters ?? {}) as ApiSavedViewFilters,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function mount(app: OpenAPIHono) {
  app.use("/v1/views", requireAuth);
  app.use("/v1/views/*", requireAuth);
  app.use("/v1/views", idempotency);
  app.use("/v1/views/*", idempotency);

  app.openapi(list, (async (c: any) => {
    const auth = c.get("auth");
    const meId = auth.user.id as string;

    // Anyone-shared OR mine. Joined with users so we can map UserRef without
    // a second round-trip.
    const rows = await db
      .select({ v: schema.savedViews, u: schema.users })
      .from(schema.savedViews)
      .innerJoin(schema.users, eq(schema.savedViews.owner_id, schema.users.id))
      .where(
        or(
          eq(schema.savedViews.scope, "shared"),
          eq(schema.savedViews.owner_id, meId)
        )
      )
      .orderBy(asc(schema.savedViews.name));

    return c.json({ items: rows.map((r) => mapView(r.v, r.u)) }, 200);
  }) as any);

  app.openapi(create, (async (c: any) => {
    const auth = c.get("auth");
    const body = c.req.valid("json");

    const inserted = await catchUnique(
      `view "${body.name}" already exists`,
      () =>
        db.insert(schema.savedViews).values({
          name: body.name,
          owner_id: auth.user.id,
          scope: body.scope,
          filters: body.filters,
        }).returning()
    );
    const row = inserted[0];
    if (!row) throw new Error("insert returned nothing");

    return c.json(mapView(row, auth.user), 201);
  }) as any);

  app.openapi(update, (async (c: any) => {
    const auth = c.get("auth");
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");

    const [existing] = await db.select().from(schema.savedViews)
      .where(eq(schema.savedViews.id, id)).limit(1);
    if (!existing) throw notFound("view");
    if (existing.owner_id !== auth.user.id) throw forbidden("only the owner can edit this view");

    const sets: Partial<typeof schema.savedViews.$inferInsert> = {};
    if (body.name !== undefined) sets.name = body.name;
    if (body.scope !== undefined) sets.scope = body.scope;
    if (body.filters !== undefined) sets.filters = body.filters;
    sets.updated_at = new Date().toISOString();

    const updated = await catchUnique(
      `view "${body.name ?? existing.name}" already exists`,
      () =>
        db.update(schema.savedViews)
          .set(sets)
          .where(eq(schema.savedViews.id, id))
          .returning()
    );
    const row = updated[0];
    if (!row) throw notFound("view");

    return c.json(mapView(row, auth.user), 200);
  }) as any);

  app.openapi(remove, (async (c: any) => {
    const auth = c.get("auth");
    const { id } = c.req.valid("param");

    const [existing] = await db.select().from(schema.savedViews)
      .where(eq(schema.savedViews.id, id)).limit(1);
    if (!existing) throw notFound("view");
    if (existing.owner_id !== auth.user.id) throw forbidden("only the owner can delete this view");

    await db.delete(schema.savedViews).where(eq(schema.savedViews.id, id));
    return c.body(null, 204);
  }) as any);
}
