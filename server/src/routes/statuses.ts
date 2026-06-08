import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import {
  Status, CreateStatus, UpdateStatus, ReorderStatuses,
  StatusTransition, CreateStatusTransition,
  ProjectKey, Uuid,
} from "@switchyard/shared";
import { db } from "../db.js";
import * as schema from "../../drizzle/schema.js";
import { errorResponses, okJson, createdJson, noContent, z, checkScope } from "./_helpers.js";
import { mapStatus } from "../lib/mappers.js";
import { getProjectByKey } from "../lib/lookups.js";
import { assertProjectReadable, assertProjectRole } from "../lib/authz.js";
import { badRequest, catchUnique, notFound, unprocessable } from "../errors.js";

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
  app.openapi(list, (async (c: any) => {
    const { key } = c.req.valid("param");
    const p = await getProjectByKey(key, { includeArchived: true });
    await assertProjectReadable(c.get("auth").user, p.id, "project");
    const rows = await db.select().from(schema.statuses)
      .where(eq(schema.statuses.project_id, p.id))
      .orderBy(asc(schema.statuses.position));
    return c.json({ items: rows.map(mapStatus) }, 200);
  }) as any);

  app.openapi(listTransitions, (async (c: any) => {
    const { key } = c.req.valid("param");
    const p = await getProjectByKey(key, { includeArchived: true });
    await assertProjectReadable(c.get("auth").user, p.id, "project");
    const rows = await db.select().from(schema.statusTransitions)
      .where(eq(schema.statusTransitions.project_id, p.id))
      .orderBy(asc(schema.statusTransitions.created_at));
    return c.json({
      items: rows.map((t) => ({
        id: t.id,
        project_id: t.project_id,
        from_status_id: t.from_status_id,
        to_status_id: t.to_status_id,
        created_at: t.created_at,
        updated_at: t.updated_at,
      })),
    }, 200);
  }) as any);

  app.openapi(create, (async (c: any) => {
    checkScope(c, "projects:manage");
    const { key } = c.req.valid("param");
    const body = c.req.valid("json");
    const project = await getProjectByKey(key, { includeArchived: true });
    await assertProjectRole(c.get("auth").user, project.id, "manage", "status");

    const status = await catchUnique(`status "${body.display_name}" already exists in this project`, () =>
      db.transaction(async (tx) => {
        // Default position = current max + 1.
        let position = body.position;
        if (position === undefined) {
          const [max] = await tx.select({ p: sql<number>`COALESCE(MAX(${schema.statuses.position}), -1)` })
            .from(schema.statuses)
            .where(eq(schema.statuses.project_id, project.id));
          position = (max?.p ?? -1) + 1;
        }

        if (body.is_default) {
          await tx.update(schema.statuses)
            .set({ is_default: false })
            .where(and(
              eq(schema.statuses.project_id, project.id),
              eq(schema.statuses.is_default, true),
            ));
        }

        const [inserted] = await tx.insert(schema.statuses).values({
          project_id: project.id,
          category: body.category,
          display_name: body.display_name,
          position,
          is_default: body.is_default ?? false,
        }).returning();

        if (!inserted) throw new Error("insert returned nothing");
        return inserted;
      })
    );

    return c.json(mapStatus(status), 201);
  }) as any);

  app.openapi(update, (async (c: any) => {
    checkScope(c, "projects:manage");
    const { key, id } = c.req.valid("param");
    const body = c.req.valid("json");
    const project = await getProjectByKey(key, { includeArchived: true });
    await assertProjectRole(c.get("auth").user, project.id, "manage", "status");

    const [existing] = await db.select().from(schema.statuses)
      .where(and(eq(schema.statuses.id, id), eq(schema.statuses.project_id, project.id)))
      .limit(1);
    if (!existing) throw notFound("status");

    const sets: Partial<typeof schema.statuses.$inferInsert> = {};
    if (body.category !== undefined) sets.category = body.category;
    if (body.display_name !== undefined) sets.display_name = body.display_name;
    if (body.position !== undefined) sets.position = body.position;
    if (body.is_default !== undefined) sets.is_default = body.is_default;

    if (Object.keys(sets).length === 0) {
      return c.json(mapStatus(existing), 200);
    }

    const updated = await catchUnique("status display_name already in use", () =>
      db.transaction(async (tx) => {
        if (body.is_default === true) {
          await tx.update(schema.statuses)
            .set({ is_default: false })
            .where(and(
              eq(schema.statuses.project_id, project.id),
              eq(schema.statuses.is_default, true),
              ne(schema.statuses.id, id),
            ));
        }
        const [u] = await tx.update(schema.statuses)
          .set(sets)
          .where(eq(schema.statuses.id, id))
          .returning();
        if (!u) throw notFound("status");
        return u;
      })
    );
    return c.json(mapStatus(updated), 200);
  }) as any);

  app.openapi(remove, (async (c: any) => {
    checkScope(c, "projects:manage");
    const { key, id } = c.req.valid("param");
    const project = await getProjectByKey(key, { includeArchived: true });
    await assertProjectRole(c.get("auth").user, project.id, "manage", "status");

    const [existing] = await db.select().from(schema.statuses)
      .where(and(eq(schema.statuses.id, id), eq(schema.statuses.project_id, project.id)))
      .limit(1);
    if (!existing) throw notFound("status");
    if (existing.is_default) throw unprocessable("cannot delete the default status");

    const countRows = await db.select({ count: sql<number>`count(*)::int` })
      .from(schema.tickets)
      .where(eq(schema.tickets.status_id, id));
    const count = countRows[0]?.count ?? 0;
    if (count > 0) {
      throw unprocessable(`status is in use by ${count} ticket${count === 1 ? "" : "s"}`);
    }

    await db.delete(schema.statuses).where(eq(schema.statuses.id, id));
    return c.body(null, 204);
  }) as any);

  app.openapi(reorder, (async (c: any) => {
    checkScope(c, "projects:manage");
    const { key } = c.req.valid("param");
    const body = c.req.valid("json");
    const project = await getProjectByKey(key, { includeArchived: true });
    await assertProjectRole(c.get("auth").user, project.id, "manage", "statuses");

    // All ids must belong to this project, and the list should cover every
    // status (so we don't leave orphans with stale positions).
    const all = await db.select().from(schema.statuses)
      .where(eq(schema.statuses.project_id, project.id));
    const allIds = new Set(all.map((s) => s.id));
    const requested = new Set(body.status_ids);
    for (const id of body.status_ids) {
      if (!allIds.has(id)) throw badRequest(`status ${id} does not belong to project ${key}`);
    }
    for (const id of allIds) {
      if (!requested.has(id)) {
        throw badRequest("reorder must include every status in the project");
      }
    }

    const updated = await db.transaction(async (tx) => {
      // Two-pass to avoid colliding with the unique (project_id, display_name)
      // index at intermediate states. We bump positions into a "scratch" range
      // (negative) first, then back to final.
      for (let i = 0; i < body.status_ids.length; i++) {
        const id = body.status_ids[i]!;
        await tx.update(schema.statuses)
          .set({ position: -(i + 1) - 100 })
          .where(eq(schema.statuses.id, id));
      }
      for (let i = 0; i < body.status_ids.length; i++) {
        const id = body.status_ids[i]!;
        await tx.update(schema.statuses)
          .set({ position: i })
          .where(eq(schema.statuses.id, id));
      }
      return tx.select().from(schema.statuses)
        .where(eq(schema.statuses.project_id, project.id))
        .orderBy(asc(schema.statuses.position));
    });

    return c.json({ items: updated.map(mapStatus) }, 200);
  }) as any);

  app.openapi(createTransition, (async (c: any) => {
    checkScope(c, "projects:manage");
    const { key } = c.req.valid("param");
    const body = c.req.valid("json");
    const project = await getProjectByKey(key, { includeArchived: true });
    await assertProjectRole(c.get("auth").user, project.id, "manage", "transition");

    // Both statuses must belong to this project. from is nullable (wildcard).
    const ids = [body.to_status_id, ...(body.from_status_id ? [body.from_status_id] : [])];
    const found = await db.select({ id: schema.statuses.id })
      .from(schema.statuses)
      .where(and(
        eq(schema.statuses.project_id, project.id),
        inArray(schema.statuses.id, ids),
      ));
    if (found.length !== ids.length) {
      throw badRequest("one or more statuses do not belong to this project");
    }

    const [created] = await catchUnique("transition already defined", () =>
      db.insert(schema.statusTransitions).values({
        project_id: project.id,
        from_status_id: body.from_status_id ?? null,
        to_status_id: body.to_status_id,
      }).returning()
    );
    if (!created) throw new Error("insert returned nothing");
    return c.json({
      id: created.id,
      project_id: created.project_id,
      from_status_id: created.from_status_id,
      to_status_id: created.to_status_id,
      created_at: created.created_at,
      updated_at: created.updated_at,
    }, 201);
  }) as any);

  app.openapi(removeTransition, (async (c: any) => {
    checkScope(c, "projects:manage");
    const { key, id } = c.req.valid("param");
    const project = await getProjectByKey(key, { includeArchived: true });
    await assertProjectRole(c.get("auth").user, project.id, "manage", "transition");
    const result = await db.delete(schema.statusTransitions)
      .where(and(
        eq(schema.statusTransitions.id, id),
        eq(schema.statusTransitions.project_id, project.id),
      ))
      .returning({ id: schema.statusTransitions.id });
    if (result.length === 0) throw notFound("transition");
    return c.body(null, 204);
  }) as any);
}
