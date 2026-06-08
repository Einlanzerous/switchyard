// Ticket template CRUD + fire_now + instances feed.
//
// Scope model mirrors tickets/rules:
//   - GET endpoints: any authenticated user
//   - POST / PATCH / DELETE: tickets:write
//   - POST .../fire_now: tickets:write (it materializes a ticket)
//
// Templates are project-scoped (project_id NOT NULL); cron+tz vs trigger_at
// is enforced at the DB layer via CHECK.

import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { and, desc, eq, type SQL } from "drizzle-orm";
import {
  TicketTemplate, CreateTicketTemplate, UpdateTicketTemplate, TicketSummary,
  Uuid, paginated, Pagination, ProjectKey,
} from "@switchyard/shared";
import { db } from "../db.js";
import * as schema from "../../drizzle/schema.js";
import { requireAuth } from "../auth.js";
import { idempotency } from "../lib/idempotency.js";
import {
  errorResponses, okJson, createdJson, noContent, checkScope, z, idempotencyHeader,
} from "./_helpers.js";
import { mapTicketTemplate } from "../lib/mappers.js";
import { getProjectByKey, getUserById } from "../lib/lookups.js";
import { materializeFromTemplate } from "../lib/templates/materializer.js";
import { loadTicketSummary } from "../lib/tickets.js";
import { assertProjectReadable, assertProjectRole } from "../lib/authz.js";
import { badRequest, notFound, unprocessable } from "../errors.js";

const tag = "Ticket Templates";

const list = createRoute({
  method: "get", path: "/v1/projects/{key}/templates", tags: [tag],
  summary: "List ticket templates for a project",
  request: { params: z.object({ key: ProjectKey }), query: Pagination },
  responses: { ...okJson(paginated(TicketTemplate)), ...errorResponses },
});

const create = createRoute({
  method: "post", path: "/v1/projects/{key}/templates", tags: [tag],
  summary: "Create a ticket template (recurring or one-shot)",
  request: {
    params: z.object({ key: ProjectKey }),
    headers: idempotencyHeader,
    body: { content: { "application/json": { schema: CreateTicketTemplate } } },
  },
  responses: { ...createdJson(TicketTemplate), ...errorResponses },
});

const get = createRoute({
  method: "get", path: "/v1/templates/{id}", tags: [tag], summary: "Get a template",
  request: { params: z.object({ id: Uuid }) },
  responses: { ...okJson(TicketTemplate), ...errorResponses },
});

const update = createRoute({
  method: "patch", path: "/v1/templates/{id}", tags: [tag], summary: "Update a template",
  request: {
    params: z.object({ id: Uuid }),
    body: { content: { "application/json": { schema: UpdateTicketTemplate } } },
  },
  responses: { ...okJson(TicketTemplate), ...errorResponses },
});

const remove = createRoute({
  method: "delete", path: "/v1/templates/{id}", tags: [tag], summary: "Delete a template",
  request: { params: z.object({ id: Uuid }) },
  responses: { ...noContent, ...errorResponses },
});

const fireNow = createRoute({
  method: "post", path: "/v1/templates/{id}/fire_now", tags: [tag],
  summary: "Materialize an instance immediately (does NOT advance last_fired_at)",
  request: { params: z.object({ id: Uuid }), headers: idempotencyHeader },
  responses: { ...createdJson(TicketSummary), ...errorResponses },
});

const instances = createRoute({
  method: "get", path: "/v1/templates/{id}/instances", tags: [tag],
  summary: "List tickets materialized from this template",
  request: { params: z.object({ id: Uuid }), query: Pagination },
  responses: { ...okJson(paginated(TicketSummary)), ...errorResponses },
});

export function mount(app: OpenAPIHono) {
  // projects.ts already mounts requireAuth on `/v1/projects/*`, so we only
  // need to cover the template-only namespace here.
  app.use("/v1/templates/*", requireAuth);
  app.use("/v1/templates/*", idempotency);
  app.use("/v1/projects/*/templates", idempotency);

  // ─── list (project-scoped) ─────────────────────────────────────────────
  app.openapi(list, (async (c: any) => {
    const { key } = c.req.valid("param");
    const project = await getProjectByKey(key);
    await assertProjectReadable(c.get("auth").user, project.id, "project");

    const rows = await db
      .select({ t: schema.ticketTemplates, project: schema.projects, assignee: schema.users })
      .from(schema.ticketTemplates)
      .innerJoin(schema.projects, eq(schema.ticketTemplates.project_id, schema.projects.id))
      .leftJoin(schema.users, eq(schema.ticketTemplates.assignee_id, schema.users.id))
      .where(eq(schema.ticketTemplates.project_id, project.id))
      .orderBy(desc(schema.ticketTemplates.created_at));

    return c.json(
      {
        items: rows.map((r) => mapTicketTemplate(r.t, { project: r.project, assignee: r.assignee })),
        page: { next_cursor: null, has_more: false },
      },
      200,
    );
  }) as any);

  // ─── create ────────────────────────────────────────────────────────────
  app.openapi(create, (async (c: any) => {
    checkScope(c, "tickets:write");
    const auth = c.get("auth") as { user: { id: string } };
    const { key } = c.req.valid("param");
    const body = c.req.valid("json");
    const project = await getProjectByKey(key);
    await assertProjectRole(c.get("auth").user, project.id, "write", "template");

    validateScheduleMode(body);
    if (body.assignee_id) await getUserById(body.assignee_id);

    const [t] = await db
      .insert(schema.ticketTemplates)
      .values({
        project_id: project.id,
        enabled: body.enabled ?? true,
        title: body.title,
        description: body.description ?? "",
        type: body.type ?? "task",
        priority: body.priority ?? null,
        assignee_id: body.assignee_id ?? null,
        parent_id: body.parent_id ?? null,
        label_ids: (body.label_ids ?? []) as any,
        metadata: (body.metadata ?? {}) as any,
        due_date_offset_days: body.due_date_offset_days ?? null,
        schedule_cron: body.schedule_cron ?? null,
        schedule_tz: body.schedule_tz ?? null,
        trigger_at: body.trigger_at ?? null,
        lead_days: body.lead_days ?? 0,
        overlap_policy: body.overlap_policy ?? "skip",
        created_by_user_id: auth.user.id,
      })
      .returning();
    if (!t) throw new Error("template insert returned nothing");

    const [assignee] = t.assignee_id
      ? await db.select().from(schema.users).where(eq(schema.users.id, t.assignee_id)).limit(1)
      : [null];

    return c.json(
      mapTicketTemplate(t, { project, assignee: (assignee ?? null) as any }),
      201,
    );
  }) as any);

  // ─── get ───────────────────────────────────────────────────────────────
  app.openapi(get, (async (c: any) => {
    const { id } = c.req.valid("param");
    // Templates inherit their project's membership. Resolve the project id
    // first so a non-member 404s before we map the (existing) template.
    const [tpl] = await db
      .select({ project_id: schema.ticketTemplates.project_id })
      .from(schema.ticketTemplates)
      .where(eq(schema.ticketTemplates.id, id))
      .limit(1);
    if (!tpl) throw notFound("template");
    await assertProjectReadable(c.get("auth").user, tpl.project_id, "template");
    const row = await loadTemplateById(id);
    return c.json(row, 200);
  }) as any);

  // ─── patch ─────────────────────────────────────────────────────────────
  app.openapi(update, (async (c: any) => {
    checkScope(c, "tickets:write");
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");

    const [existing] = await db
      .select()
      .from(schema.ticketTemplates)
      .where(eq(schema.ticketTemplates.id, id))
      .limit(1);
    if (!existing) throw notFound("template");
    await assertProjectRole(c.get("auth").user, existing.project_id, "write", "template");

    // If the caller is flipping schedule mode, validate the merged shape.
    const merged = {
      schedule_cron: body.schedule_cron !== undefined ? body.schedule_cron : existing.schedule_cron,
      trigger_at: body.trigger_at !== undefined ? body.trigger_at : existing.trigger_at,
    };
    validateScheduleMode(merged);

    const sets: Partial<typeof schema.ticketTemplates.$inferInsert> = {};
    if (body.title !== undefined) sets.title = body.title;
    if (body.description !== undefined) sets.description = body.description;
    if (body.type !== undefined) sets.type = body.type;
    if (body.priority !== undefined) sets.priority = body.priority;
    if (body.assignee_id !== undefined) sets.assignee_id = body.assignee_id;
    if (body.parent_id !== undefined) sets.parent_id = body.parent_id;
    if (body.label_ids !== undefined) sets.label_ids = body.label_ids as any;
    if (body.metadata !== undefined) sets.metadata = body.metadata as any;
    if (body.due_date_offset_days !== undefined) sets.due_date_offset_days = body.due_date_offset_days;
    if (body.schedule_cron !== undefined) sets.schedule_cron = body.schedule_cron;
    if (body.schedule_tz !== undefined) sets.schedule_tz = body.schedule_tz;
    if (body.trigger_at !== undefined) sets.trigger_at = body.trigger_at;
    if (body.lead_days !== undefined) sets.lead_days = body.lead_days;
    if (body.overlap_policy !== undefined) sets.overlap_policy = body.overlap_policy;
    if (body.enabled !== undefined) sets.enabled = body.enabled;

    if (Object.keys(sets).length === 0) {
      return c.json(await loadTemplateById(id), 200);
    }

    sets.updated_at = new Date().toISOString();
    await db.update(schema.ticketTemplates).set(sets).where(eq(schema.ticketTemplates.id, id));
    return c.json(await loadTemplateById(id), 200);
  }) as any);

  // ─── delete ────────────────────────────────────────────────────────────
  app.openapi(remove, (async (c: any) => {
    checkScope(c, "tickets:write");
    const { id } = c.req.valid("param");
    const [existing] = await db
      .select({ project_id: schema.ticketTemplates.project_id })
      .from(schema.ticketTemplates)
      .where(eq(schema.ticketTemplates.id, id))
      .limit(1);
    if (!existing) throw notFound("template");
    await assertProjectRole(c.get("auth").user, existing.project_id, "write", "template");
    const result = await db
      .delete(schema.ticketTemplates)
      .where(eq(schema.ticketTemplates.id, id))
      .returning({ id: schema.ticketTemplates.id });
    if (result.length === 0) throw notFound("template");
    return c.body(null, 204);
  }) as any);

  // ─── fire_now (additive — does NOT advance last_fired_at) ──────────────
  app.openapi(fireNow, (async (c: any) => {
    checkScope(c, "tickets:write");
    const { id } = c.req.valid("param");
    const [tpl] = await db
      .select()
      .from(schema.ticketTemplates)
      .where(eq(schema.ticketTemplates.id, id))
      .limit(1);
    if (!tpl) throw notFound("template");
    await assertProjectRole(c.get("auth").user, tpl.project_id, "write", "template");

    const now = new Date();
    const result = await db.transaction(async (tx) => {
      return await materializeFromTemplate(tx as any, tpl, now);
    });

    if (result.kind === "skipped") {
      throw badRequest("overlap policy prevented fire (an open instance exists)");
    }

    return c.json(await loadTicketSummary(result.ticket), 201);
  }) as any);

  // ─── instances (tickets materialized from this template) ───────────────
  app.openapi(instances, (async (c: any) => {
    const { id } = c.req.valid("param");
    // Gate on the template's project before listing its materialized tickets.
    const [tpl] = await db
      .select({ project_id: schema.ticketTemplates.project_id })
      .from(schema.ticketTemplates)
      .where(eq(schema.ticketTemplates.id, id))
      .limit(1);
    if (!tpl) throw notFound("template");
    await assertProjectReadable(c.get("auth").user, tpl.project_id, "template");

    const rows = await db
      .select()
      .from(schema.tickets)
      .where(eq(schema.tickets.template_id, id))
      .orderBy(desc(schema.tickets.created_at))
      .limit(100);

    const items = await Promise.all(rows.map((t) => loadTicketSummary(t)));
    return c.json({ items, page: { next_cursor: null, has_more: false } }, 200);
  }) as any);
}

// ─── helpers ─────────────────────────────────────────────────────────────

function validateScheduleMode(body: { schedule_cron?: string | null; trigger_at?: string | null }) {
  const hasCron = !!body.schedule_cron;
  const hasTrigger = !!body.trigger_at;
  if (hasCron === hasTrigger) {
    throw unprocessable(
      "exactly one of `schedule_cron` (recurring) or `trigger_at` (one-shot) must be set",
    );
  }
}

async function loadTemplateById(id: string) {
  const [r] = await db
    .select({ t: schema.ticketTemplates, project: schema.projects, assignee: schema.users })
    .from(schema.ticketTemplates)
    .innerJoin(schema.projects, eq(schema.ticketTemplates.project_id, schema.projects.id))
    .leftJoin(schema.users, eq(schema.ticketTemplates.assignee_id, schema.users.id))
    .where(eq(schema.ticketTemplates.id, id))
    .limit(1);
  if (!r) throw notFound("template");
  return mapTicketTemplate(r.t, { project: r.project, assignee: r.assignee });
}
