import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { and, asc, eq } from "drizzle-orm";
import { Label, CreateLabel, UpdateLabel, ProjectKey, Uuid } from "@switchyard/shared";
import { db } from "../db.js";
import * as schema from "../../drizzle/schema.js";
import { errorResponses, okJson, createdJson, noContent, scope, z, checkScope } from "./_helpers.js";
import { mapLabel } from "../lib/mappers.js";
import { getProjectByKey } from "../lib/lookups.js";
import { catchUnique, notFound } from "../errors.js";

const tag = "Labels";

const list = createRoute({
  method: "get", path: "/v1/projects/{key}/labels", tags: [tag], summary: "List a project's labels",
  request: { params: z.object({ key: ProjectKey }) },
  responses: { ...okJson(z.object({ items: z.array(Label) })), ...errorResponses },
});

const create = createRoute({
  method: "post", path: "/v1/projects/{key}/labels", tags: [tag], summary: "Create a label",
  request: {
    params: z.object({ key: ProjectKey }),
    body: { content: { "application/json": { schema: CreateLabel } } },
  },
  responses: { ...createdJson(Label), ...errorResponses },
});

const update = createRoute({
  method: "patch", path: "/v1/projects/{key}/labels/{id}", tags: [tag], summary: "Update a label",
  request: {
    params: z.object({ key: ProjectKey, id: Uuid }),
    body: { content: { "application/json": { schema: UpdateLabel } } },
  },
  responses: { ...okJson(Label), ...errorResponses },
});

const remove = createRoute({
  method: "delete", path: "/v1/projects/{key}/labels/{id}", tags: [tag], summary: "Delete a label",
  request: { params: z.object({ key: ProjectKey, id: Uuid }) },
  responses: { ...noContent, ...errorResponses },
});

export function mount(app: OpenAPIHono) {
  app.openapi(list, (async (c: any) => {
    const { key } = c.req.valid("param");
    const p = await getProjectByKey(key, { includeArchived: true });
    const rows = await db.select().from(schema.labels)
      .where(eq(schema.labels.project_id, p.id))
      .orderBy(asc(schema.labels.name));
    return c.json({ items: rows.map(mapLabel) }, 200);
  }) as any);

  app.openapi(create, (async (c: any) => {
    checkScope(c, "projects:manage");
    const { key } = c.req.valid("param");
    const body = c.req.valid("json");
    const project = await getProjectByKey(key, { includeArchived: true });
    const [inserted] = await catchUnique(`label "${body.name}" already exists in this project`, () =>
      db.insert(schema.labels).values({
        project_id: project.id,
        name: body.name,
        color: body.color,
      }).returning()
    );
    if (!inserted) throw new Error("insert returned nothing");
    return c.json(mapLabel(inserted), 201);
  }) as any);

  app.openapi(update, (async (c: any) => {
    checkScope(c, "projects:manage");
    const { key, id } = c.req.valid("param");
    const body = c.req.valid("json");
    const project = await getProjectByKey(key, { includeArchived: true });

    const [existing] = await db.select().from(schema.labels)
      .where(and(eq(schema.labels.id, id), eq(schema.labels.project_id, project.id)))
      .limit(1);
    if (!existing) throw notFound("label");

    const sets: Partial<typeof schema.labels.$inferInsert> = {};
    if (body.name !== undefined) sets.name = body.name;
    if (body.color !== undefined) sets.color = body.color;
    if (Object.keys(sets).length === 0) return c.json(mapLabel(existing), 200);

    const [updated] = await catchUnique("label name already in use", () =>
      db.update(schema.labels)
        .set(sets)
        .where(eq(schema.labels.id, id))
        .returning()
    );
    if (!updated) throw notFound("label");
    return c.json(mapLabel(updated), 200);
  }) as any);

  app.openapi(remove, (async (c: any) => {
    checkScope(c, "projects:manage");
    const { key, id } = c.req.valid("param");
    const project = await getProjectByKey(key, { includeArchived: true });
    const result = await db.delete(schema.labels)
      .where(and(eq(schema.labels.id, id), eq(schema.labels.project_id, project.id)))
      .returning({ id: schema.labels.id });
    if (result.length === 0) throw notFound("label");
    return c.body(null, 204);
  }) as any);
}
