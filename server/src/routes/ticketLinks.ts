// Typed cross-ticket relations: blocks, relates_to, duplicates. Stored
// once from the source side; GET returns both outgoing + incoming rows
// for the ticket in scope, tagged by direction so the UI can pick the
// right verb.

import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { eq } from "drizzle-orm";
import {
  TicketLink, CreateTicketLink, Uuid,
} from "@switchyard/shared";
import { db } from "../db.js";
import * as schema from "../../drizzle/schema.js";
import { requireAuth } from "../auth.js";
import { idempotency } from "../lib/idempotency.js";
import { errorResponses, okJson, createdJson, noContent, checkScope, z, idempotencyHeader } from "./_helpers.js";
import { mapTicketLink, mapUserRef } from "../lib/mappers.js";
import { resolveTicket } from "../lib/lookups.js";
import { loadTicketLinks, loadTicketSummary } from "../lib/tickets.js";
import { writeEvent } from "../lib/events.js";
import { assertProjectReadable } from "../lib/authz.js";
import { badRequest, notFound, catchUnique } from "../errors.js";

const tag = "Ticket Links";
const idOrKey = z.string().min(1);

const list = createRoute({
  method: "get", path: "/v1/tickets/{idOrKey}/links", tags: [tag],
  summary: "List typed cross-ticket relations involving this ticket",
  request: { params: z.object({ idOrKey }) },
  responses: { ...okJson(z.object({ items: z.array(TicketLink) })), ...errorResponses },
});

const create = createRoute({
  method: "post", path: "/v1/tickets/{idOrKey}/links", tags: [tag],
  summary: "Create a typed cross-ticket relation (source = path ticket)",
  request: {
    params: z.object({ idOrKey }),
    headers: idempotencyHeader,
    body: { content: { "application/json": { schema: CreateTicketLink } } },
  },
  responses: { ...createdJson(TicketLink), ...errorResponses },
});

const remove = createRoute({
  method: "delete", path: "/v1/tickets/links/{id}", tags: [tag],
  summary: "Remove a typed cross-ticket relation",
  request: { params: z.object({ id: Uuid }) },
  responses: { ...noContent, ...errorResponses },
});

export function mount(app: OpenAPIHono) {
  // requireAuth + idempotency are already mounted on /v1/tickets/* by routes/tickets.ts.
  // For the standalone /v1/tickets/links/{id} DELETE we need to add them here.
  app.use("/v1/tickets/links/*", requireAuth);
  app.use("/v1/tickets/links/*", idempotency);

  // ─── list ────────────────────────────────────────────────────────────────
  app.openapi(list, (async (c: any) => {
    const { idOrKey: param } = c.req.valid("param");
    const ticket = await resolveTicket(param);
    // Gate on the path ticket's project. The link list intentionally still
    // surfaces the key + title of linked tickets in OTHER projects the caller
    // can't access — cross-project relationship metadata is visible by design
    // (see docs/permissions.md); only direct fetch of those tickets 404s.
    await assertProjectReadable(c.get("auth").user, ticket.project_id, "ticket");
    const items = await loadTicketLinks(ticket.id);
    return c.json({ items }, 200);
  }) as any);

  // ─── create ──────────────────────────────────────────────────────────────
  app.openapi(create, (async (c: any) => {
    checkScope(c, "tickets:write");
    const { idOrKey: param } = c.req.valid("param");
    const body = c.req.valid("json");
    const auth = c.get("auth");

    const source = await resolveTicket(param);
    const target = await resolveTicket(body.target).catch(() => {
      throw badRequest(`target ticket "${body.target}" not found`);
    });

    if (source.id === target.id) throw badRequest("a ticket cannot link to itself");

    const inserted = await db.transaction(async (tx) => {
      const [created] = await catchUnique(
        `link already exists: ${body.type} between these tickets`,
        () =>
          tx
            .insert(schema.ticketLinks)
            .values({
              source_ticket_id: source.id,
              target_ticket_id: target.id,
              type: body.type,
              created_by: auth.user.id,
            })
            .returning(),
      );
      if (!created) throw new Error("link insert returned nothing");

      // Emit ticket.link_added against the SOURCE ticket so rules /
      // subscriptions scoped to its project see it. The payload carries
      // the link type + the other ticket's key so receivers don't need
      // a follow-up fetch.
      const sourceSummary = await loadTicketSummary(source, tx as any);
      const targetSummary = await loadTicketSummary(target, tx as any);
      await writeEvent(tx as any, {
        event_type: "ticket.link_added",
        actor: mapUserRef(auth.user),
        ticket: sourceSummary,
        project_id: source.project_id,
        extras: {
          link_id: created.id,
          link_type: created.type,
          other_ticket: { id: targetSummary.id, key: targetSummary.key, title: targetSummary.title },
        },
      });
      // Also emit against the target so its project hears about it. The
      // event_id will be different but the link_id is the same, so
      // de-dup is easy if a downstream cares.
      if (target.project_id !== source.project_id) {
        await writeEvent(tx as any, {
          event_type: "ticket.link_added",
          actor: mapUserRef(auth.user),
          ticket: targetSummary,
          project_id: target.project_id,
          extras: {
            link_id: created.id,
            link_type: created.type,
            other_ticket: { id: sourceSummary.id, key: sourceSummary.key, title: sourceSummary.title },
          },
        });
      }

      return created;
    });

    // Build the response with direction relative to the source ticket
    // (caller's path-param POV).
    const otherProject = (await db.select().from(schema.projects)
      .where(eq(schema.projects.id, target.project_id)).limit(1))[0]!;
    return c.json(
      mapTicketLink(inserted, {
        viewingTicketId: source.id,
        otherTicket: { id: target.id, number: target.number },
        otherProjectKey: otherProject.key,
        otherTitle: target.title,
        creator: auth.user,
      }),
      201,
    );
  }) as any);

  // ─── delete ──────────────────────────────────────────────────────────────
  app.openapi(remove, (async (c: any) => {
    checkScope(c, "tickets:write");
    const { id } = c.req.valid("param");
    const auth = c.get("auth");

    const [existing] = await db.select().from(schema.ticketLinks)
      .where(eq(schema.ticketLinks.id, id)).limit(1);
    if (!existing) throw notFound("ticket link");

    const [source, target] = await Promise.all([
      db.select().from(schema.tickets).where(eq(schema.tickets.id, existing.source_ticket_id)).limit(1).then((r) => r[0]),
      db.select().from(schema.tickets).where(eq(schema.tickets.id, existing.target_ticket_id)).limit(1).then((r) => r[0]),
    ]);
    if (!source || !target) throw notFound("ticket link"); // FK should prevent this

    await db.transaction(async (tx) => {
      await tx.delete(schema.ticketLinks).where(eq(schema.ticketLinks.id, id));

      const sourceSummary = await loadTicketSummary(source, tx as any);
      const targetSummary = await loadTicketSummary(target, tx as any);
      await writeEvent(tx as any, {
        event_type: "ticket.link_removed",
        actor: mapUserRef(auth.user),
        ticket: sourceSummary,
        project_id: source.project_id,
        extras: {
          link_id: existing.id,
          link_type: existing.type,
          other_ticket: { id: targetSummary.id, key: targetSummary.key, title: targetSummary.title },
        },
      });
      if (target.project_id !== source.project_id) {
        await writeEvent(tx as any, {
          event_type: "ticket.link_removed",
          actor: mapUserRef(auth.user),
          ticket: targetSummary,
          project_id: target.project_id,
          extras: {
            link_id: existing.id,
            link_type: existing.type,
            other_ticket: { id: sourceSummary.id, key: sourceSummary.key, title: sourceSummary.title },
          },
        });
      }
    });

    return c.body(null, 204);
  }) as any);
}
