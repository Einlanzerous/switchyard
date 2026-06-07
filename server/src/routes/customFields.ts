// Custom field schema CRUD. Defines typed views over the `metadata`
// JSONB column on tickets. Storage stays in metadata — declaring a
// field doesn't migrate existing data; deleting one doesn't drop any.
//
// Scope: projects:manage for writes (same as project / status / label
// management). Reads are auth-only.

import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { and, asc, eq, inArray, isNull, or, type SQL } from "drizzle-orm";
import {
  CustomField, CreateCustomField, UpdateCustomField, Uuid,
} from "@switchyard/shared";
import { db } from "../db.js";
import * as schema from "../../drizzle/schema.js";
import { requireAuth } from "../auth.js";
import { idempotency } from "../lib/idempotency.js";
import { errorResponses, okJson, createdJson, noContent, checkScope, z } from "./_helpers.js";
import { mapCustomField } from "../lib/mappers.js";
import { assertProjectReadable, hasInstanceWideAccess, visibleProjectIds } from "../lib/authz.js";
import { catchUnique, notFound } from "../errors.js";

const tag = "Custom Fields";

const list = createRoute({
  method: "get", path: "/v1/custom-fields", tags: [tag],
  summary: "List custom fields (global + optionally scoped to a project key)",
  request: { query: z.object({ project: z.string().optional() }) },
  responses: { ...okJson(z.object({ items: z.array(CustomField) })), ...errorResponses },
});

const create = createRoute({
  method: "post", path: "/v1/custom-fields", tags: [tag], summary: "Create a custom field",
  request: { body: { content: { "application/json": { schema: CreateCustomField } } } },
  responses: { ...createdJson(CustomField), ...errorResponses },
});

const get = createRoute({
  method: "get", path: "/v1/custom-fields/{id}", tags: [tag], summary: "Get a custom field",
  request: { params: z.object({ id: Uuid }) },
  responses: { ...okJson(CustomField), ...errorResponses },
});

const update = createRoute({
  method: "patch", path: "/v1/custom-fields/{id}", tags: [tag],
  summary: "Update a custom field (key / project_id / type are immutable)",
  request: {
    params: z.object({ id: Uuid }),
    body: { content: { "application/json": { schema: UpdateCustomField } } },
  },
  responses: { ...okJson(CustomField), ...errorResponses },
});

const remove = createRoute({
  method: "delete", path: "/v1/custom-fields/{id}", tags: [tag],
  summary: "Delete a custom field (metadata.<key> data on tickets is left intact)",
  request: { params: z.object({ id: Uuid }) },
  responses: { ...noContent, ...errorResponses },
});

export function mount(app: OpenAPIHono) {
  app.use("/v1/custom-fields/*", requireAuth);
  app.use("/v1/custom-fields/*", idempotency);

  // ─── list ────────────────────────────────────────────────────────────────
  app.openapi(list, (async (c: any) => {
    const q = c.req.valid("query");
    const user = c.get("auth").user;
    const conds: SQL[] = [];
    if (q.project) {
      const [proj] = await db.select({ id: schema.projects.id })
        .from(schema.projects).where(eq(schema.projects.key, q.project)).limit(1);
      if (!proj) return c.json({ items: [] }, 200);
      // 6.1.2: a non-member naming a real project they can't see gets 404.
      await assertProjectReadable(user, proj.id, "project");
      // A scoped query returns both project-specific AND global fields,
      // so callers like the ticket-create form get the full set in one
      // request.
      conds.push(or(eq(schema.customFields.project_id, proj.id), isNull(schema.customFields.project_id))!);
    } else if (!hasInstanceWideAccess(user)) {
      // Unscoped list: globals (project_id NULL — instance-wide config, like
      // labels) plus only the member's visible projects' fields. Never leak
      // other projects' field definitions.
      const ids = await visibleProjectIds(user);
      conds.push(
        ids.size > 0
          ? or(isNull(schema.customFields.project_id), inArray(schema.customFields.project_id, [...ids]))!
          : isNull(schema.customFields.project_id),
      );
    }
    const rows = await db.select().from(schema.customFields)
      .where(conds.length > 0 ? and(...conds) : undefined)
      .orderBy(asc(schema.customFields.project_id), asc(schema.customFields.key));
    return c.json({ items: rows.map(mapCustomField) }, 200);
  }) as any);

  // ─── create ──────────────────────────────────────────────────────────────
  app.openapi(create, (async (c: any) => {
    checkScope(c, "projects:manage");
    const body = c.req.valid("json");

    if (body.project_id) {
      const [proj] = await db.select({ id: schema.projects.id })
        .from(schema.projects).where(eq(schema.projects.id, body.project_id)).limit(1);
      if (!proj) throw notFound("project");
    }

    const [inserted] = await catchUnique(
      `custom field "${body.key}" already exists for this scope`,
      () =>
        db.insert(schema.customFields).values({
          project_id: body.project_id ?? null,
          key: body.key,
          label: body.label,
          type: body.type,
          options: (body.options ?? null) as any,
          show_on_card: body.show_on_card ?? false,
          show_on_create_form: body.show_on_create_form ?? false,
          show_on_filter_bar: body.show_on_filter_bar ?? false,
        }).returning(),
    );
    if (!inserted) throw new Error("custom field insert returned nothing");

    return c.json(mapCustomField(inserted), 201);
  }) as any);

  // ─── get ─────────────────────────────────────────────────────────────────
  app.openapi(get, (async (c: any) => {
    const { id } = c.req.valid("param");
    const [row] = await db.select().from(schema.customFields)
      .where(eq(schema.customFields.id, id)).limit(1);
    if (!row) throw notFound("custom field");
    // Globals are instance-wide; project-scoped fields gate on membership.
    if (row.project_id) {
      await assertProjectReadable(c.get("auth").user, row.project_id, "custom field");
    }
    return c.json(mapCustomField(row), 200);
  }) as any);

  // ─── patch ───────────────────────────────────────────────────────────────
  app.openapi(update, (async (c: any) => {
    checkScope(c, "projects:manage");
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");

    const [existing] = await db.select().from(schema.customFields)
      .where(eq(schema.customFields.id, id)).limit(1);
    if (!existing) throw notFound("custom field");

    // options is only meaningful for type=select; reject mismatches even
    // on PATCH so the field row never lies about its shape.
    if (body.options !== undefined && body.options !== null && existing.type !== "select") {
      throw new Error("options is only valid for type=select");
    }

    const sets: Partial<typeof schema.customFields.$inferInsert> = {};
    if (body.label !== undefined) sets.label = body.label;
    if (body.options !== undefined) sets.options = body.options as any;
    if (body.show_on_card !== undefined) sets.show_on_card = body.show_on_card;
    if (body.show_on_create_form !== undefined) sets.show_on_create_form = body.show_on_create_form;
    if (body.show_on_filter_bar !== undefined) sets.show_on_filter_bar = body.show_on_filter_bar;

    if (Object.keys(sets).length === 0) return c.json(mapCustomField(existing), 200);

    sets.updated_at = new Date().toISOString();
    const [updated] = await db.update(schema.customFields).set(sets)
      .where(eq(schema.customFields.id, id)).returning();
    if (!updated) throw notFound("custom field");
    return c.json(mapCustomField(updated), 200);
  }) as any);

  // ─── delete ──────────────────────────────────────────────────────────────
  app.openapi(remove, (async (c: any) => {
    checkScope(c, "projects:manage");
    const { id } = c.req.valid("param");
    const result = await db.delete(schema.customFields)
      .where(eq(schema.customFields.id, id))
      .returning({ id: schema.customFields.id });
    if (result.length === 0) throw notFound("custom field");
    return c.body(null, 204);
  }) as any);
}
