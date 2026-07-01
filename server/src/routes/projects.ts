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
import { errorResponses, okJson, createdJson, noContent, z, checkScope } from "./_helpers.js";
import { mapProject, mapUserRef } from "../lib/mappers.js";
import { getProjectByKey } from "../lib/lookups.js";
import { addProjectToDefaultBoard, removeProjectFromDefaultBoard } from "../lib/defaultBoard.js";
import { buildPage, cursorOrderBy, cursorWhere, decodeCursor } from "../lib/pagination.js";
import { writeEvent } from "../lib/events.js";
import { assertInstanceAdmin, assertProjectReadable, assertProjectRole, effectiveProjectRole, visibleProjectFilter } from "../lib/authz.js";
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
    // 6.1.2 read scoping: members see only their projects; owner/agent → null.
    const scope = await visibleProjectFilter(c.get("auth").user, schema.projects.id);
    if (scope) conds.push(scope);
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
    const user = c.get("auth").user;
    await assertProjectReadable(user, p.id, "project");
    // Surface the caller's effective role so the client can gate the Members
    // tab (6.4). Only on the single-project GET — the list omits it.
    const my_role = await effectiveProjectRole(user, p.id);
    return c.json({ ...mapProject(p), my_role }, 200);
  }) as any);

  app.openapi(create, (async (c: any) => {
    checkScope(c, "projects:manage");
    const auth = c.get("auth");
    // Creating a project is an instance-level act — a project-admin role can't
    // mint new projects, only owners/agents (or an instance-admin token).
    assertInstanceAdmin(auth.user, "project creation");
    const body = c.req.valid("json");

    const project = await catchUnique(`project key "${body.key}" already exists`, () =>
      db.transaction(async (tx) => {
        const [created] = await tx.insert(schema.projects).values({
          key: body.key,
          name: body.name,
          description: body.description ?? null,
          color: body.color ?? null,
          repo_url: body.repo_url ?? null,
          default_test_cmd: body.default_test_cmd ?? null,
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
    await assertProjectRole(auth.user, existing.id, "manage", "project");

    const sets: Partial<typeof schema.projects.$inferInsert> = {};
    if (body.name !== undefined) sets.name = body.name;
    if (body.description !== undefined) sets.description = body.description ?? null;
    if (body.color !== undefined) sets.color = body.color ?? null;
    if (body.repo_url !== undefined) sets.repo_url = body.repo_url ?? null;
    if (body.default_test_cmd !== undefined) sets.default_test_cmd = body.default_test_cmd ?? null;
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
    await assertProjectRole(auth.user, existing.id, "manage", "project");

    await db.transaction(async (tx) => {
      await tx.update(schema.projects)
        .set({ deleted_at: new Date().toISOString() })
        .where(eq(schema.projects.id, existing.id));

      await writeEvent(tx as any, {
        event_type: "project.deleted",
        actor: mapUserRef(auth.user),
        project_id: existing.id,
      });

      // Cascade-soft-delete the project's live tickets (SWY-127). A soft-deleted
      // project vanishes from /v1/projects, but its tickets keep deleted_at NULL
      // and orphan — leaking into ticket-derived views (e.g. drydock's
      // by-project grouping). No per-ticket events: project.deleted is the
      // signal, and a bulk fan-out would be noise.
      await tx.update(schema.tickets)
        .set({ deleted_at: new Date().toISOString() })
        .where(and(eq(schema.tickets.project_id, existing.id), isNull(schema.tickets.deleted_at)));

      // Soft-delete doesn't fire FK cascade on board_projects, so prune
      // explicitly. (Hard-delete would cascade, but we don't hard-delete.)
      await removeProjectFromDefaultBoard(tx as any, existing.id);
    });

    return c.body(null, 204);
  }) as any);
}
