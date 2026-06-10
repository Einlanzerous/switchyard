import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { and, asc, eq } from "drizzle-orm";
import {
  ProjectMember, AddProjectMember, UpdateProjectMember,
  ProjectKey, Uuid,
} from "@switchyard/shared";
import { db } from "../db.js";
import * as schema from "../../drizzle/schema.js";
import { errorResponses, okJson, createdJson, noContent, z, checkScope } from "./_helpers.js";
import { mapProjectMember } from "../lib/mappers.js";
import { getProjectByKey, getUserById } from "../lib/lookups.js";
import { assertProjectReadable, assertProjectRole } from "../lib/authz.js";
import { catchUnique, notFound } from "../errors.js";

// Phase 6.4 — per-project membership CRUD over the `user_projects` join table.
// Lives in the `/v1/projects/{key}/*` family (mirrors statuses.ts), so it leans
// on the `requireAuth` + `idempotency` wildcard middleware projects.mount()
// registers — this file adds no `app.use`. Membership management is project-
// admin (+ owner/agent) only: reads 404 for non-members (existence hiding) and
// 403 for member-but-not-admin; writes 403 + the `projects:manage` token scope.

const tag = "Project Members";

const list = createRoute({
  method: "get", path: "/v1/projects/{key}/members", tags: [tag], summary: "List a project's members",
  request: { params: z.object({ key: ProjectKey }) },
  responses: { ...okJson(z.object({ items: z.array(ProjectMember) })), ...errorResponses },
});

const add = createRoute({
  method: "post", path: "/v1/projects/{key}/members", tags: [tag], summary: "Add a member to a project",
  request: {
    params: z.object({ key: ProjectKey }),
    body: { content: { "application/json": { schema: AddProjectMember } } },
  },
  responses: { ...createdJson(ProjectMember), ...errorResponses },
});

const update = createRoute({
  method: "patch", path: "/v1/projects/{key}/members/{userId}", tags: [tag], summary: "Change a member's role",
  request: {
    params: z.object({ key: ProjectKey, userId: Uuid }),
    body: { content: { "application/json": { schema: UpdateProjectMember } } },
  },
  responses: { ...okJson(ProjectMember), ...errorResponses },
});

const remove = createRoute({
  method: "delete", path: "/v1/projects/{key}/members/{userId}", tags: [tag], summary: "Remove a member from a project",
  request: { params: z.object({ key: ProjectKey, userId: Uuid }) },
  responses: { ...noContent, ...errorResponses },
});

export function mount(app: OpenAPIHono) {
  app.openapi(list, (async (c: any) => {
    const { key } = c.req.valid("param");
    const user = c.get("auth").user;
    const project = await getProjectByKey(key, { includeArchived: true });
    // Two-step gate: 404 hides projects a non-member can't see at all; 403 then
    // tells a viewer/editor member the roster is admin-only.
    await assertProjectReadable(user, project.id, "project");
    await assertProjectRole(user, project.id, "manage", "members");

    const rows = await db
      .select({ user: schema.users, role: schema.userProjects.role, created_at: schema.userProjects.created_at })
      .from(schema.userProjects)
      .innerJoin(schema.users, eq(schema.userProjects.user_id, schema.users.id))
      .where(eq(schema.userProjects.project_id, project.id))
      .orderBy(asc(schema.userProjects.created_at));

    return c.json({ items: rows.map((r) => mapProjectMember(r.user, r.role, r.created_at)) }, 200);
  }) as any);

  app.openapi(add, (async (c: any) => {
    checkScope(c, "projects:manage");
    const { key } = c.req.valid("param");
    const body = c.req.valid("json");
    const project = await getProjectByKey(key, { includeArchived: true });
    await assertProjectRole(c.get("auth").user, project.id, "manage", "members");

    const target = await getUserById(body.user_id);
    const [row] = await catchUnique("user is already a member of this project", () =>
      db.insert(schema.userProjects).values({
        user_id: target.id,
        project_id: project.id,
        role: body.role,
      }).returning()
    );
    if (!row) throw new Error("membership insert returned nothing");
    return c.json(mapProjectMember(target, row.role, row.created_at), 201);
  }) as any);

  app.openapi(update, (async (c: any) => {
    checkScope(c, "projects:manage");
    const { key, userId } = c.req.valid("param");
    const body = c.req.valid("json");
    const project = await getProjectByKey(key, { includeArchived: true });
    await assertProjectRole(c.get("auth").user, project.id, "manage", "members");

    const [row] = await db.update(schema.userProjects)
      .set({ role: body.role })
      .where(and(
        eq(schema.userProjects.user_id, userId),
        eq(schema.userProjects.project_id, project.id),
      ))
      .returning();
    if (!row) throw notFound("member");

    const target = await getUserById(userId);
    return c.json(mapProjectMember(target, row.role, row.created_at), 200);
  }) as any);

  app.openapi(remove, (async (c: any) => {
    checkScope(c, "projects:manage");
    const { key, userId } = c.req.valid("param");
    const project = await getProjectByKey(key, { includeArchived: true });
    await assertProjectRole(c.get("auth").user, project.id, "manage", "members");

    const [row] = await db.delete(schema.userProjects)
      .where(and(
        eq(schema.userProjects.user_id, userId),
        eq(schema.userProjects.project_id, project.id),
      ))
      .returning();
    if (!row) throw notFound("member");
    return c.body(null, 204);
  }) as any);
}
