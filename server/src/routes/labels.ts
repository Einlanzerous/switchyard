import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { asc, eq, sql } from "drizzle-orm";
import { Label, CreateLabel, UpdateLabel, Uuid } from "@switchyard/shared";
import { db } from "../db.js";
import * as schema from "../../drizzle/schema.js";
import { requireAuth } from "../auth.js";
import { idempotency } from "../lib/idempotency.js";
import { errorResponses, okJson, createdJson, noContent, checkScope, z } from "./_helpers.js";
import { mapLabel } from "../lib/mappers.js";
import { catchUnique, notFound, unprocessable } from "../errors.js";

// Labels live in a single global catalog (no project scoping). Any ticket
// in any project can carry any subset of these labels. CRUD requires
// projects:manage today; we'll consider a dedicated labels:manage scope
// later if multi-tenancy becomes a thing.
const tag = "Labels";

const list = createRoute({
  method: "get", path: "/v1/labels", tags: [tag], summary: "List labels",
  responses: { ...okJson(z.object({ items: z.array(Label) })), ...errorResponses },
});

const create = createRoute({
  method: "post", path: "/v1/labels", tags: [tag], summary: "Create a label",
  request: { body: { content: { "application/json": { schema: CreateLabel } } } },
  responses: { ...createdJson(Label), ...errorResponses },
});

const update = createRoute({
  method: "patch", path: "/v1/labels/{id}", tags: [tag], summary: "Update a label",
  request: {
    params: z.object({ id: Uuid }),
    body: { content: { "application/json": { schema: UpdateLabel } } },
  },
  responses: { ...okJson(Label), ...errorResponses },
});

const remove = createRoute({
  method: "delete", path: "/v1/labels/{id}", tags: [tag], summary: "Delete a label",
  request: {
    params: z.object({ id: Uuid }),
    query: z.object({
      force: z
        .enum(["true", "false"])
        .optional()
        .describe(
          "When omitted or `false`, deleting a label that is still attached to one or " +
          "more tickets returns 422. Pass `force=true` to delete anyway and let the " +
          "FK cascade strip the label off every referencing ticket.",
        ),
    }),
  },
  responses: { ...noContent, ...errorResponses },
});

export function mount(app: OpenAPIHono) {
  app.use("/v1/labels/*", requireAuth);
  app.use("/v1/labels/*", idempotency);

  app.openapi(list, (async (c: any) => {
    const rows = await db.select().from(schema.labels).orderBy(asc(schema.labels.name));
    return c.json({ items: rows.map(mapLabel) }, 200);
  }) as any);

  // scope is checked inside the handler — passing `scope("…")` as
  // middleware to app.openapi breaks the validator chain so c.req.valid
  // is undefined when the handler runs. See Phase 1.6 pattern note.
  app.openapi(create, (async (c: any) => {
    checkScope(c, "projects:manage");
    const body = c.req.valid("json");
    const [inserted] = await catchUnique(`label "${body.name}" already exists`, () =>
      db.insert(schema.labels).values({ name: body.name, color: body.color }).returning()
    );
    if (!inserted) throw new Error("insert returned nothing");
    return c.json(mapLabel(inserted), 201);
  }) as any);

  app.openapi(update, (async (c: any) => {
    checkScope(c, "projects:manage");
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");

    const [existing] = await db.select().from(schema.labels).where(eq(schema.labels.id, id)).limit(1);
    if (!existing) throw notFound("label");

    const sets: Partial<typeof schema.labels.$inferInsert> = {};
    if (body.name !== undefined) sets.name = body.name;
    if (body.color !== undefined) sets.color = body.color;
    if (Object.keys(sets).length === 0) return c.json(mapLabel(existing), 200);

    const [updated] = await catchUnique("label name already in use", () =>
      db.update(schema.labels).set(sets).where(eq(schema.labels.id, id)).returning()
    );
    if (!updated) throw notFound("label");
    return c.json(mapLabel(updated), 200);
  }) as any);

  app.openapi(remove, (async (c: any) => {
    checkScope(c, "projects:manage");
    const { id } = c.req.valid("param");
    const { force } = c.req.valid("query");

    const [existing] = await db.select({ id: schema.labels.id })
      .from(schema.labels)
      .where(eq(schema.labels.id, id))
      .limit(1);
    if (!existing) throw notFound("label");

    if (force !== "true") {
      const countRows = await db.select({ count: sql<number>`count(*)::int` })
        .from(schema.ticketLabels)
        .where(eq(schema.ticketLabels.label_id, id));
      const count = countRows[0]?.count ?? 0;
      if (count > 0) {
        throw unprocessable(
          `label is in use by ${count} ticket${count === 1 ? "" : "s"} — re-issue with ?force=true to delete anyway`,
        );
      }
    }

    await db.delete(schema.labels).where(eq(schema.labels.id, id));
    return c.body(null, 204);
  }) as any);
}
