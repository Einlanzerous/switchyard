import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import {
  and, asc, desc, eq, gt, ilike, inArray, isNull, lt, ne, or, sql, type SQL,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  Ticket, TicketSummary, CreateTicket, UpdateTicket, TransitionTicket,
  TicketListFilters, Event, paginated, Pagination,
  StatusCategory, TicketType,
  type TicketSummary as ApiTicketSummary,
  type EventType,
} from "@switchyard/shared";
import { db } from "../db.js";
import * as schema from "../../drizzle/schema.js";
import { requireAuth } from "../auth.js";
import { idempotency } from "../lib/idempotency.js";
import { errorResponses, okJson, createdJson, noContent, checkScope, z, idempotencyHeader } from "./_helpers.js";
import { mapEvent, mapTicketSummary, mapStatusRef, mapUserRef } from "../lib/mappers.js";
import { resolveTicket, getProjectByKey, getStatusById, getUserById } from "../lib/lookups.js";
import { buildPage, cursorOrderBy, cursorWhere, decodeCursor } from "../lib/pagination.js";
import { writeEvent } from "../lib/events.js";
import { loadTicketDetail, loadTicketSummary, allocateTicketNumber } from "../lib/tickets.js";
import { detectAndNotify, detectAndNotifyOnEdit } from "../lib/mentions.js";
import { badRequest, unprocessable } from "../errors.js";

const tag = "Tickets";
const idOrKey = z.string().min(1);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUS_CATEGORIES = new Set<string>(StatusCategory.options);
const TICKET_TYPES = new Set<string>(TicketType.options);

const list = createRoute({
  method: "get", path: "/v1/tickets", tags: [tag], summary: "List tickets",
  request: { query: TicketListFilters.merge(Pagination) },
  responses: { ...okJson(paginated(TicketSummary)), ...errorResponses },
});

const create = createRoute({
  method: "post", path: "/v1/tickets", tags: [tag], summary: "Create a ticket",
  request: {
    headers: idempotencyHeader,
    body: { content: { "application/json": { schema: CreateTicket } } },
  },
  responses: { ...createdJson(Ticket), ...errorResponses },
});

const get = createRoute({
  method: "get", path: "/v1/tickets/{idOrKey}", tags: [tag],
  summary: "Get a ticket by UUID or KEY (e.g. SWY-47)",
  request: { params: z.object({ idOrKey }) },
  responses: { ...okJson(Ticket), ...errorResponses },
});

const update = createRoute({
  method: "patch", path: "/v1/tickets/{idOrKey}", tags: [tag], summary: "Update a ticket",
  request: {
    params: z.object({ idOrKey }),
    headers: idempotencyHeader,
    body: { content: { "application/json": { schema: UpdateTicket } } },
  },
  responses: { ...okJson(Ticket), ...errorResponses },
});

const remove = createRoute({
  method: "delete", path: "/v1/tickets/{idOrKey}", tags: [tag], summary: "Soft-delete a ticket",
  request: { params: z.object({ idOrKey }) },
  responses: { ...noContent, ...errorResponses },
});

const transition = createRoute({
  method: "post", path: "/v1/tickets/{idOrKey}/transition", tags: [tag],
  summary: "Move a ticket to a new status (validates transitions table + epic guard)",
  request: {
    params: z.object({ idOrKey }),
    headers: idempotencyHeader,
    body: { content: { "application/json": { schema: TransitionTicket } } },
  },
  responses: { ...okJson(Ticket), ...errorResponses },
});

const events = createRoute({
  method: "get", path: "/v1/tickets/{idOrKey}/events", tags: [tag], summary: "Audit history for a ticket",
  request: { params: z.object({ idOrKey }), query: Pagination },
  responses: { ...okJson(paginated(Event)), ...errorResponses },
});

const children = createRoute({
  method: "get", path: "/v1/tickets/{idOrKey}/children", tags: [tag],
  summary: "List child tickets (for an epic)",
  request: { params: z.object({ idOrKey }), query: Pagination },
  responses: { ...okJson(paginated(TicketSummary)), ...errorResponses },
});

export function mount(app: OpenAPIHono) {
  app.use("/v1/tickets/*", requireAuth);
  app.use("/v1/tickets/*", idempotency);

  // ─── list ────────────────────────────────────────────────────────────────
  app.openapi(list, (async (c: any) => {
    const q = c.req.valid("query");
    const limit = q.limit;

    const conds: SQL[] = [];
    if (!q.include_deleted) conds.push(isNull(schema.tickets.deleted_at));

    if (q.project) {
      const keys = q.project.split(",").map((k: string) => k.trim()).filter(Boolean);
      if (keys.length > 0) {
        const projects = await db.select({ id: schema.projects.id }).from(schema.projects)
          .where(inArray(schema.projects.key, keys));
        if (projects.length === 0) {
          return c.json({ items: [], page: { next_cursor: null, has_more: false } }, 200);
        }
        conds.push(inArray(schema.tickets.project_id, projects.map((p) => p.id)));
      }
    }

    if (q.status) {
      const values = q.status.split(",").map((s: string) => s.trim()).filter(Boolean);
      const ids: string[] = [];
      const categories: string[] = [];
      for (const v of values) {
        if (UUID_RE.test(v)) ids.push(v);
        else if (STATUS_CATEGORIES.has(v)) categories.push(v);
        else throw badRequest(`unknown status value: ${v}`);
      }
      const statusConds: SQL[] = [];
      if (ids.length > 0) statusConds.push(inArray(schema.tickets.status_id, ids));
      if (categories.length > 0) {
        statusConds.push(
          sql`EXISTS (SELECT 1 FROM statuses s WHERE s.id = ${schema.tickets.status_id} AND s.category = ANY(${sql.raw(`ARRAY[${categories.map((cat: string) => `'${cat}'`).join(",")}]::status_category[]`)}))`
        );
      }
      if (statusConds.length === 1) conds.push(statusConds[0]!);
      else if (statusConds.length > 1) conds.push(or(...statusConds)!);
    }

    if (q.type) {
      const types = q.type.split(",").map((t: string) => t.trim()).filter(Boolean);
      for (const t of types) {
        if (!TICKET_TYPES.has(t)) throw badRequest(`unknown type: ${t}`);
      }
      conds.push(inArray(schema.tickets.type, types as any));
    }

    if (q.label) {
      const labelIds = q.label.split(",").map((s: string) => s.trim()).filter(Boolean);
      if (labelIds.length > 0) {
        conds.push(
          sql`EXISTS (SELECT 1 FROM ticket_labels tl WHERE tl.ticket_id = ${schema.tickets.id} AND tl.label_id = ANY(${sql.raw(`ARRAY[${labelIds.map((id: string) => `'${id}'`).join(",")}]::uuid[]`)}))`
        );
      }
    }

    if (q.assignee) {
      if (q.assignee === "unassigned") conds.push(isNull(schema.tickets.assignee_id));
      else conds.push(eq(schema.tickets.assignee_id, q.assignee));
    }

    if (q.reporter) conds.push(eq(schema.tickets.reporter_id, q.reporter));
    if (q.parent_id) conds.push(eq(schema.tickets.parent_id, q.parent_id));

    if (q.text) {
      const pattern = `%${q.text}%`;
      conds.push(or(
        ilike(schema.tickets.title, pattern),
        ilike(schema.tickets.description, pattern),
      )!);
    }

    if (q.updated_after) conds.push(gt(schema.tickets.updated_at, q.updated_after));
    if (q.updated_before) conds.push(lt(schema.tickets.updated_at, q.updated_before));

    // Custom field filters: any query param matching `cf.<key>` matches
    // `metadata -> '<key>'` on the ticket. JSONB equality is text-based
    // here — we cast both sides to text so the param works regardless
    // of whether the stored value is a string, number, or boolean. Keep
    // this past the Zod parse so unknown params don't 400.
    const rawUrl = new URL(c.req.url);
    for (const [param, value] of rawUrl.searchParams) {
      if (!param.startsWith("cf.")) continue;
      const key = param.slice(3);
      if (!/^[a-z][a-z0-9_]*$/.test(key)) {
        throw badRequest(`invalid custom field key in filter: ${param}`);
      }
      conds.push(
        sql`${schema.tickets.metadata}->>${key} = ${value}`,
      );
    }

    if (q.cursor) {
      const cur = decodeCursor(q.cursor);
      if (!cur) throw badRequest("invalid cursor");
      conds.push(cursorWhere(schema.tickets.updated_at, schema.tickets.id, cur));
    }

    const assignee = alias(schema.users, "assignee");
    const reporter = alias(schema.users, "reporter");

    const rows = await db.select({
      t: schema.tickets,
      project: schema.projects,
      status: schema.statuses,
      assignee,
      reporter,
    })
      .from(schema.tickets)
      .innerJoin(schema.projects, eq(schema.tickets.project_id, schema.projects.id))
      .innerJoin(schema.statuses, eq(schema.tickets.status_id, schema.statuses.id))
      .leftJoin(assignee, eq(schema.tickets.assignee_id, assignee.id))
      .innerJoin(reporter, eq(schema.tickets.reporter_id, reporter.id))
      .where(conds.length > 0 ? and(...conds) : undefined)
      .orderBy(...cursorOrderBy(schema.tickets.updated_at, schema.tickets.id))
      .limit(limit + 1);

    const ticketIds = rows.map((r) => r.t.id);
    const labelsByTicket = await fetchLabelsByTicket(ticketIds);

    const summaries: ApiTicketSummary[] = rows.map((r) =>
      mapTicketSummary(r.t, {
        project: r.project,
        status: r.status,
        assignee: r.assignee,
        reporter: r.reporter,
        labels: labelsByTicket.get(r.t.id) ?? [],
        number: r.t.number,
      })
    );

    return c.json(buildPage(summaries, limit), 200);
  }) as any);

  // ─── detail ──────────────────────────────────────────────────────────────
  app.openapi(get, (async (c: any) => {
    const { idOrKey: param } = c.req.valid("param");
    const ticket = await resolveTicket(param);
    return c.json(await loadTicketDetail(ticket), 200);
  }) as any);

  // ─── create ──────────────────────────────────────────────────────────────
  app.openapi(create, (async (c: any) => {
    checkScope(c, "tickets:write");
    const body = c.req.valid("json");
    const auth = c.get("auth");

    const project = await getProjectByKey(body.project_key, { includeArchived: false });

    // Validate parent (epic in same project, not deleted). Trigger backstops.
    if (body.parent_id) {
      const [parent] = await db.select().from(schema.tickets)
        .where(and(eq(schema.tickets.id, body.parent_id), isNull(schema.tickets.deleted_at)))
        .limit(1);
      if (!parent) throw badRequest("parent ticket not found");
      if (parent.project_id !== project.id) throw badRequest("parent must be in the same project");
      if (parent.type !== "epic") throw badRequest("parent must be an epic");
      if (body.type === "epic") throw badRequest("epics cannot have a parent");
    }

    if (body.assignee_id) await getUserById(body.assignee_id);

    // Resolve target status: explicit, else project default.
    let statusId = body.status_id;
    if (!statusId) {
      const [def] = await db.select({ id: schema.statuses.id })
        .from(schema.statuses)
        .where(and(eq(schema.statuses.project_id, project.id), eq(schema.statuses.is_default, true)))
        .limit(1);
      if (!def) throw badRequest("project has no default status");
      statusId = def.id;
    } else {
      const status = await getStatusById(statusId);
      if (status.project_id !== project.id) throw badRequest("status does not belong to this project");
    }

    if (body.label_ids && body.label_ids.length > 0) {
      // Labels are global — just verify each id resolves to a real row.
      const labels = await db.select({ id: schema.labels.id }).from(schema.labels)
        .where(inArray(schema.labels.id, body.label_ids));
      if (labels.length !== body.label_ids.length) {
        throw badRequest("one or more label_ids do not exist");
      }
    }

    // One txn covers ticket insert + label inserts + ticket.created event so
    // the audit log can never disagree with the ticket table.
    const inserted = await db.transaction(async (tx) => {
      const number = await allocateTicketNumber(tx, project.id);

      const [t] = await tx.insert(schema.tickets).values({
        project_id: project.id,
        number,
        type: body.type,
        title: body.title,
        description: body.description ?? "",
        status_id: statusId!,
        priority: body.priority ?? null,
        parent_id: body.parent_id ?? null,
        assignee_id: body.assignee_id ?? null,
        reporter_id: auth.user.id,
        due_date: body.due_date ?? null,
        // Default position: epoch-ms-now, matching the backfill so newly
        // created tickets show up at the top of their column. Manual reorder
        // overrides via PATCH or /transition.
        position: Date.now(),
        metadata: (body.metadata ?? {}) as any,
      }).returning();

      if (!t) throw new Error("ticket insert returned nothing");

      if (body.label_ids && body.label_ids.length > 0) {
        await tx.insert(schema.ticketLabels).values(
          body.label_ids.map((label_id: string) => ({ ticket_id: t.id, label_id }))
        );
      }

      const summary = await loadTicketSummary(t, tx as any);
      await writeEvent(tx as any, {
        event_type: "ticket.created",
        actor: mapUserRef(auth.user),
        ticket: summary,
        project_id: project.id,
      });

      // Description-source @mention notifications. comment_id stays null.
      if (t.description) {
        await detectAndNotify(tx as any, {
          text: t.description,
          actor: auth.user,
          ticket_id: t.id,
          comment_id: null,
          source: "description",
        });
      }

      return t;
    });

    return c.json(await loadTicketDetail(inserted), 201);
  }) as any);

  // ─── update ──────────────────────────────────────────────────────────────
  app.openapi(update, (async (c: any) => {
    checkScope(c, "tickets:write");
    const { idOrKey: param } = c.req.valid("param");
    const body = c.req.valid("json");
    const auth = c.get("auth");
    const existing = await resolveTicket(param);
    const project = await db.select().from(schema.projects).where(eq(schema.projects.id, existing.project_id)).limit(1).then((r) => r[0]);
    if (!project) throw badRequest("orphan ticket: project missing");

    // Validate parent if changed.
    if (body.parent_id !== undefined && body.parent_id !== null) {
      if (body.parent_id === existing.id) throw badRequest("ticket cannot be its own parent");
      const [parent] = await db.select().from(schema.tickets)
        .where(and(eq(schema.tickets.id, body.parent_id), isNull(schema.tickets.deleted_at)))
        .limit(1);
      if (!parent) throw badRequest("parent ticket not found");
      if (parent.project_id !== existing.project_id) throw badRequest("parent must be in the same project");
      if (parent.type !== "epic") throw badRequest("parent must be an epic");
      if (existing.type === "epic") throw badRequest("epics cannot have a parent");
    }

    if (body.assignee_id !== undefined && body.assignee_id !== null) {
      await getUserById(body.assignee_id);
    }

    if (body.label_ids !== undefined && body.label_ids.length > 0) {
      // Labels are global — just verify each id resolves to a real row.
      const labels = await db.select({ id: schema.labels.id }).from(schema.labels)
        .where(inArray(schema.labels.id, body.label_ids));
      if (labels.length !== body.label_ids.length) {
        throw badRequest("one or more label_ids do not exist");
      }
    }

    const sets: Partial<typeof schema.tickets.$inferInsert> = {};
    if (body.title !== undefined) sets.title = body.title;
    if (body.description !== undefined) sets.description = body.description ?? "";
    if (body.priority !== undefined) sets.priority = body.priority ?? null;
    if (body.parent_id !== undefined) sets.parent_id = body.parent_id ?? null;
    if (body.assignee_id !== undefined) sets.assignee_id = body.assignee_id ?? null;
    if (body.due_date !== undefined) sets.due_date = body.due_date ?? null;
    if (body.metadata !== undefined) sets.metadata = body.metadata as any;
    if (body.position !== undefined) sets.position = body.position;

    const noFieldChanges = Object.keys(sets).length === 0;
    const noLabelChange = body.label_ids === undefined;
    if (noFieldChanges && noLabelChange) {
      return c.json(await loadTicketDetail(existing), 200);
    }

    const updated = await db.transaction(async (tx) => {
      let row = existing;
      if (!noFieldChanges) {
        const [u] = await tx.update(schema.tickets)
          .set(sets)
          .where(eq(schema.tickets.id, existing.id))
          .returning();
        if (!u) throw new Error("update returned nothing");
        row = u;
      }

      if (!noLabelChange) {
        await tx.delete(schema.ticketLabels).where(eq(schema.ticketLabels.ticket_id, existing.id));
        if (body.label_ids!.length > 0) {
          await tx.insert(schema.ticketLabels).values(
            body.label_ids!.map((label_id: string) => ({ ticket_id: existing.id, label_id }))
          );
        }
      }

      // ticket.updated event with field diff. Build summary inside the txn so
      // the embedded label set reflects the just-replaced ticket_labels.
      const summary = await loadTicketSummary(row, tx as any);
      const fields = Object.keys(sets).map((field) => ({
        field,
        from: (existing as any)[field] ?? null,
        to: (sets as any)[field] ?? null,
      }));
      if (!noLabelChange) fields.push({ field: "labels", from: null, to: null });

      await writeEvent(tx as any, {
        event_type: "ticket.updated",
        actor: mapUserRef(auth.user),
        ticket: summary,
        project_id: existing.project_id,
        changes: fields.length > 0 ? { fields } : undefined,
      });
      if (body.assignee_id !== undefined && body.assignee_id !== existing.assignee_id) {
        await writeEvent(tx as any, {
          event_type: "ticket.assigned",
          actor: mapUserRef(auth.user),
          ticket: summary,
          project_id: existing.project_id,
        });
      }

      // Description-source @mentions. Only notify users who appear in the
      // new description but not the old one.
      if (body.description !== undefined && body.description !== existing.description) {
        await detectAndNotifyOnEdit(tx as any, {
          oldText: existing.description,
          newText: body.description ?? "",
          actor: auth.user,
          ticket_id: existing.id,
          comment_id: null,
          source: "description",
        });
      }

      return row;
    });

    return c.json(await loadTicketDetail(updated), 200);
  }) as any);

  // ─── delete (soft) ───────────────────────────────────────────────────────
  app.openapi(remove, (async (c: any) => {
    checkScope(c, "tickets:write");
    const { idOrKey: param } = c.req.valid("param");
    const auth = c.get("auth");
    const existing = await resolveTicket(param);

    const summary = await loadTicketSummary(existing);

    await db.transaction(async (tx) => {
      await tx.update(schema.tickets)
        .set({ deleted_at: new Date().toISOString() })
        .where(eq(schema.tickets.id, existing.id));

      await writeEvent(tx as any, {
        event_type: "ticket.deleted",
        actor: mapUserRef(auth.user),
        ticket: summary,
        project_id: existing.project_id,
      });
    });

    return c.body(null, 204);
  }) as any);

  // ─── transition ──────────────────────────────────────────────────────────
  app.openapi(transition, (async (c: any) => {
    checkScope(c, "tickets:write");
    const { idOrKey: param } = c.req.valid("param");
    const body = c.req.valid("json");
    const auth = c.get("auth");
    const existing = await resolveTicket(param);

    const fromStatus = await getStatusById(existing.status_id);
    const toStatus = await getStatusById(body.status_id);
    if (toStatus.project_id !== existing.project_id) {
      throw badRequest("target status does not belong to this project");
    }

    // Resolution rules: required iff target is closed; rejected otherwise.
    if (toStatus.category === "closed" && !body.resolution) {
      throw unprocessable("resolution is required when transitioning to a closed status");
    }
    if (toStatus.category !== "closed" && body.resolution) {
      throw unprocessable("resolution must be omitted when target is not closed");
    }

    // Transitions table: zero rows = wildcard, any rows = whitelist.
    const allTransitions = await db.select().from(schema.statusTransitions)
      .where(eq(schema.statusTransitions.project_id, existing.project_id));
    if (allTransitions.length > 0) {
      const allowed = allTransitions.some((t) =>
        t.to_status_id === toStatus.id &&
        (t.from_status_id === null || t.from_status_id === fromStatus.id)
      );
      if (!allowed) {
        throw unprocessable(
          `transition from ${fromStatus.display_name} to ${toStatus.display_name} is not allowed`,
          { from: fromStatus.display_name, to: toStatus.display_name }
        );
      }
    }

    // Epic-close guard.
    if (existing.type === "epic" && toStatus.category === "closed") {
      const openChildren = await db.select({
        id: schema.tickets.id,
        number: schema.tickets.number,
        title: schema.tickets.title,
      })
        .from(schema.tickets)
        .innerJoin(schema.statuses, eq(schema.tickets.status_id, schema.statuses.id))
        .where(and(
          eq(schema.tickets.parent_id, existing.id),
          isNull(schema.tickets.deleted_at),
          ne(schema.statuses.category, "closed"),
        ));

      if (openChildren.length > 0) {
        throw unprocessable(
          `cannot close epic: ${openChildren.length} child ticket${openChildren.length === 1 ? "" : "s"} not yet closed`,
          { open_children: openChildren }
        );
      }
    }

    // Apply state change + comment + the event cluster atomically. If any
    // event insert fails we'd rather roll back the whole transition than have
    // a status change with no audit trail.
    const updated = await db.transaction(async (tx) => {
      // The transition can also reposition the ticket inside its new column
      // — the drag-to-reorder UX uses this to drop into a specific index.
      const transitionSets: Partial<typeof schema.tickets.$inferInsert> = {
        status_id: toStatus.id,
        resolution: body.resolution ?? null,
      };
      if (body.position !== undefined) transitionSets.position = body.position;

      const [u] = await tx.update(schema.tickets)
        .set(transitionSets)
        .where(eq(schema.tickets.id, existing.id))
        .returning();
      if (!u) throw new Error("update returned nothing");

      if (body.comment) {
        await tx.insert(schema.comments).values({
          ticket_id: existing.id,
          author_id: auth.user.id,
          body: body.comment,
        });
      }

      const summary = await loadTicketSummary(u, tx as any);
      const statusChange = {
        from: mapStatusRef(fromStatus),
        to: mapStatusRef(toStatus),
        resolution: body.resolution ?? null,
      };

      // status_changed always; closed if entering closed; released if resolution=released.
      const eventTypes: EventType[] = ["ticket.status_changed"];
      if (toStatus.category === "closed") eventTypes.push("ticket.closed");
      if (body.resolution === "released") eventTypes.push("ticket.released");
      for (const evt of eventTypes) {
        await writeEvent(tx as any, {
          event_type: evt,
          actor: mapUserRef(auth.user),
          ticket: summary,
          project_id: existing.project_id,
          changes: { status: statusChange },
        });
      }

      if (body.comment) {
        await writeEvent(tx as any, {
          event_type: "comment.created",
          actor: mapUserRef(auth.user),
          ticket: summary,
          project_id: existing.project_id,
          extras: { comment_body: body.comment },
        });
      }

      return u;
    });

    return c.json(await loadTicketDetail(updated), 200);
  }) as any);

  // ─── audit history ───────────────────────────────────────────────────────
  app.openapi(events, (async (c: any) => {
    const { idOrKey: param } = c.req.valid("param");
    const q = c.req.valid("query");
    const limit = q.limit;
    const ticket = await resolveTicket(param, { includeDeleted: true });

    const conds: SQL[] = [eq(schema.events.ticket_id, ticket.id)];
    if (q.cursor) {
      const cur = decodeCursor(q.cursor);
      if (!cur) throw badRequest("invalid cursor");
      conds.push(or(
        lt(schema.events.created_at, cur.u),
        and(eq(schema.events.created_at, cur.u), lt(schema.events.id, cur.i))!,
      )!);
    }

    const rows = await db.select().from(schema.events)
      .where(and(...conds))
      .orderBy(desc(schema.events.created_at), desc(schema.events.id))
      .limit(limit + 1);

    const has_more = rows.length > limit;
    const slice = has_more ? rows.slice(0, limit) : rows;
    const items = slice.map(mapEvent);
    const last = has_more ? slice[slice.length - 1] : null;
    const next_cursor = last
      ? Buffer.from(JSON.stringify({ u: last.created_at, i: last.id }), "utf8").toString("base64url")
      : null;

    return c.json({ items, page: { next_cursor, has_more } }, 200);
  }) as any);

  // ─── children of an epic ────────────────────────────────────────────────
  app.openapi(children, (async (c: any) => {
    const { idOrKey: param } = c.req.valid("param");
    const q = c.req.valid("query");
    const limit = q.limit;
    const parent = await resolveTicket(param);

    const conds: SQL[] = [
      eq(schema.tickets.parent_id, parent.id),
      isNull(schema.tickets.deleted_at),
    ];
    if (q.cursor) {
      const cur = decodeCursor(q.cursor);
      if (!cur) throw badRequest("invalid cursor");
      conds.push(cursorWhere(schema.tickets.updated_at, schema.tickets.id, cur));
    }

    const assignee = alias(schema.users, "assignee");
    const reporter = alias(schema.users, "reporter");

    const rows = await db.select({
      t: schema.tickets,
      project: schema.projects,
      status: schema.statuses,
      assignee,
      reporter,
    })
      .from(schema.tickets)
      .innerJoin(schema.projects, eq(schema.tickets.project_id, schema.projects.id))
      .innerJoin(schema.statuses, eq(schema.tickets.status_id, schema.statuses.id))
      .leftJoin(assignee, eq(schema.tickets.assignee_id, assignee.id))
      .innerJoin(reporter, eq(schema.tickets.reporter_id, reporter.id))
      .where(and(...conds))
      .orderBy(...cursorOrderBy(schema.tickets.updated_at, schema.tickets.id))
      .limit(limit + 1);

    const ticketIds = rows.map((r) => r.t.id);
    const labelsByTicket = await fetchLabelsByTicket(ticketIds);

    const summaries = rows.map((r) =>
      mapTicketSummary(r.t, {
        project: r.project,
        status: r.status,
        assignee: r.assignee,
        reporter: r.reporter,
        labels: labelsByTicket.get(r.t.id) ?? [],
        number: r.t.number,
      })
    );

    return c.json(buildPage(summaries, limit), 200);
  }) as any);

}

// ─── helpers ────────────────────────────────────────────────────────────────

async function fetchLabelsByTicket(ticketIds: string[]): Promise<Map<string, (typeof schema.labels.$inferSelect)[]>> {
  if (ticketIds.length === 0) return new Map();
  const rows = await db.select({
    ticket_id: schema.ticketLabels.ticket_id,
    label: schema.labels,
  })
    .from(schema.ticketLabels)
    .innerJoin(schema.labels, eq(schema.ticketLabels.label_id, schema.labels.id))
    .where(inArray(schema.ticketLabels.ticket_id, ticketIds));

  const out = new Map<string, (typeof schema.labels.$inferSelect)[]>();
  for (const r of rows) {
    const list = out.get(r.ticket_id) ?? [];
    list.push(r.label);
    out.set(r.ticket_id, list);
  }
  return out;
}
