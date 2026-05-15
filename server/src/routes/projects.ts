import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { and, eq, isNull, type SQL } from "drizzle-orm";
import {
  Project, CreateProject, UpdateProject,
  ProjectKey, paginated, Pagination,
} from "@switchyard/shared";
import { db } from "../db.js";
import * as schema from "../../drizzle/schema.js";
import { requireAuth } from "../auth.js";
import { idempotency } from "../lib/idempotency.js";
import { errorResponses, okJson, createdJson, noContent, scope, z, checkScope } from "./_helpers.js";
import { mapProject, mapUserRef } from "../lib/mappers.js";
import { getProjectByKey } from "../lib/lookups.js";
import { addProjectToDefaultBoard, removeProjectFromDefaultBoard } from "../lib/defaultBoard.js";
import { buildPage, cursorOrderBy, cursorWhere, decodeCursor } from "../lib/pagination.js";
import { writeEvent } from "../lib/events.js";
import { badRequest, catchUnique } from "../errors.js";

const tag = "Projects";

const DEFAULT_STATUSES: Array<{
  category: "backlog" | "planning" | "in_progress" | "blocked" | "closed";
  display_name: string;
  position: number;
  is_default?: boolean;
}> = [
  { category: "backlog", display_name: "Backlog", position: 0, is_default: true },
  { category: "planning", display_name: "Planning", position: 1 },
  { category: "in_progress", display_name: "In Progress", position: 2 },
  { category: "blocked", display_name: "Blocked", position: 3 },
  { category: "closed", display_name: "Closed", position: 4 },
];

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
  app.use("/v1/projects/*", idempotency);

  app.openapi(list, (async (c: any) => {
    const q = c.req.valid("query");
    const limit = q.limit;
    const conds: SQL[] = [isNull(schema.projects.deleted_at)];
    if (!q.include_archived) conds.push(isNull(schema.projects.archived_at));
    if (q.cursor) {
      const cur = decodeCursor(q.cursor);
      if (!cur) throw badRequest("invalid cursor");
      conds.push(cursorWhere(schema.projects.updated_at, schema.projects.id, cur));
    }
    const rows = await db.select().from(schema.projects)
      .where(and(...conds))
      .orderBy(...cursorOrderBy(schema.projects.updated_at, schema.projects.id))
      .limit(limit + 1);
    return c.json(buildPage(rows.map(mapProject), limit), 200);
  }) as any);

  app.openapi(get, (async (c: any) => {
    const { key } = c.req.valid("param");
    const p = await getProjectByKey(key, { includeArchived: true });
    return c.json(mapProject(p), 200);
  }) as any);

  app.openapi(create, (async (c: any) => {
    checkScope(c, "projects:manage");
    const body = c.req.valid("json");
    const auth = c.get("auth");

    const project = await catchUnique(`project key "${body.key}" already exists`, () =>
      db.transaction(async (tx) => {
        const [created] = await tx.insert(schema.projects).values({
          key: body.key,
          name: body.name,
          description: body.description ?? null,
          color: body.color ?? null,
          repo_url: body.repo_url ?? null,
          board_closed_window_days: body.board_closed_window_days ?? null,
        }).returning();
        if (!created) throw new Error("project insert returned nothing");

        await tx.insert(schema.projectCounters).values({
          project_id: created.id,
        });

        await tx.insert(schema.statuses).values(
          DEFAULT_STATUSES.map((s) => ({
            project_id: created.id,
            category: s.category,
            display_name: s.display_name,
            position: s.position,
            is_default: s.is_default ?? false,
          }))
        );

        await writeEvent(tx as any, {
          event_type: "project.created",
          actor: mapUserRef(auth.user),
          project_id: created.id,
        });

        // Keep the auto-managed "All projects" board in sync. No-op when
        // the user has deleted that board (the helper guards on existence).
        await addProjectToDefaultBoard(tx as any, created.id);

        return created;
      })
    );

    return c.json(mapProject(project), 201);
  }) as any);

  app.openapi(update, (async (c: any) => {
    checkScope(c, "projects:manage");
    const { key } = c.req.valid("param");
    const body = c.req.valid("json");
    const auth = c.get("auth");
    const existing = await getProjectByKey(key, { includeArchived: true });

    const sets: Partial<typeof schema.projects.$inferInsert> = {};
    if (body.name !== undefined) sets.name = body.name;
    if (body.description !== undefined) sets.description = body.description ?? null;
    if (body.color !== undefined) sets.color = body.color ?? null;
    if (body.repo_url !== undefined) sets.repo_url = body.repo_url ?? null;
    if (body.board_closed_window_days !== undefined) {
      // null clears the override; the DB CHECK rejects anything outside {7,14,30}.
      sets.board_closed_window_days = body.board_closed_window_days;
    }
    if (body.archived !== undefined) {
      sets.archived_at = body.archived
        ? (existing.archived_at ?? new Date().toISOString())
        : null;
    }

    if (Object.keys(sets).length === 0) {
      return c.json(mapProject(existing), 200);
    }

    const updated = await db.transaction(async (tx) => {
      const [u] = await tx.update(schema.projects)
        .set(sets)
        .where(eq(schema.projects.id, existing.id))
        .returning();
      if (!u) throw new Error("update returned nothing");

      await writeEvent(tx as any, {
        event_type: "project.updated",
        actor: mapUserRef(auth.user),
        project_id: u.id,
        changes: {
          fields: Object.keys(sets).map((field) => ({
            field,
            from: (existing as any)[field] ?? null,
            to: (sets as any)[field] ?? null,
          })),
        },
      });

      // Archive flips drive the default board membership — archived
      // projects shouldn't clutter the "show me everything" view.
      if (body.archived === true && !existing.archived_at) {
        await removeProjectFromDefaultBoard(tx as any, u.id);
      } else if (body.archived === false && existing.archived_at) {
        await addProjectToDefaultBoard(tx as any, u.id);
      }

      return u;
    });

    return c.json(mapProject(updated), 200);
  }) as any);

  app.openapi(remove, (async (c: any) => {
    checkScope(c, "projects:manage");
    const { key } = c.req.valid("param");
    const auth = c.get("auth");
    const existing = await getProjectByKey(key, { includeArchived: true });

    await db.transaction(async (tx) => {
      await tx.update(schema.projects)
        .set({ deleted_at: new Date().toISOString() })
        .where(eq(schema.projects.id, existing.id));

      await writeEvent(tx as any, {
        event_type: "project.deleted",
        actor: mapUserRef(auth.user),
        project_id: existing.id,
      });

      // Soft-delete doesn't fire FK cascade on board_projects, so prune
      // explicitly. (Hard-delete would cascade, but we don't hard-delete.)
      await removeProjectFromDefaultBoard(tx as any, existing.id);
    });

    return c.body(null, 204);
  }) as any);
}
