// First-class external refs on tickets (GitHub PR / issue / commit /
// Actions / generic). 4.5.2 ships manual attach + polling; 4.5.3 layers
// on the GitHub webhook receiver + auto-detect from PR conventions.

import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { eq, inArray } from "drizzle-orm";
import {
  ExternalRef, CreateExternalRef, Uuid,
} from "@switchyard/shared";
import { db } from "../db.js";
import * as schema from "../../drizzle/schema.js";
import { requireAuth } from "../auth.js";
import { idempotency } from "../lib/idempotency.js";
import { errorResponses, okJson, createdJson, noContent, checkScope, z, idempotencyHeader } from "./_helpers.js";
import { mapExternalRef, mapUserRef } from "../lib/mappers.js";
import { resolveTicket } from "../lib/lookups.js";
import { loadTicketSummary } from "../lib/tickets.js";
import { writeEvent } from "../lib/events.js";
import { detectKind, urlMatchesKind } from "../lib/externalRefs/detectKind.js";
import { assertProjectReadable } from "../lib/authz.js";
import { badRequest, catchUnique, notFound } from "../errors.js";

const tag = "External Refs";
const idOrKey = z.string().min(1);

const list = createRoute({
  method: "get", path: "/v1/tickets/{idOrKey}/external-refs", tags: [tag],
  summary: "List external refs attached to this ticket",
  request: { params: z.object({ idOrKey }) },
  responses: { ...okJson(z.object({ items: z.array(ExternalRef) })), ...errorResponses },
});

const create = createRoute({
  method: "post", path: "/v1/tickets/{idOrKey}/external-refs", tags: [tag],
  summary: "Attach an external ref (kind inferred from URL when omitted)",
  request: {
    params: z.object({ idOrKey }),
    headers: idempotencyHeader,
    body: { content: { "application/json": { schema: CreateExternalRef } } },
  },
  responses: { ...createdJson(ExternalRef), ...errorResponses },
});

const remove = createRoute({
  method: "delete", path: "/v1/tickets/external-refs/{id}", tags: [tag],
  summary: "Detach an external ref",
  request: { params: z.object({ id: Uuid }) },
  responses: { ...noContent, ...errorResponses },
});

export function mount(app: OpenAPIHono) {
  // /v1/tickets/* already has requireAuth + idempotency mounted by
  // routes/tickets.ts. Add for the standalone delete path.
  app.use("/v1/tickets/external-refs/*", requireAuth);
  app.use("/v1/tickets/external-refs/*", idempotency);

  // ─── list ────────────────────────────────────────────────────────────────
  app.openapi(list, (async (c: any) => {
    const { idOrKey: param } = c.req.valid("param");
    const ticket = await resolveTicket(param);
    // External refs belong to the path ticket's project (6.1.1).
    await assertProjectReadable(c.get("auth").user, ticket.project_id, "ticket");
    const rows = await db
      .select()
      .from(schema.ticketExternalRefs)
      .where(eq(schema.ticketExternalRefs.ticket_id, ticket.id))
      .orderBy(schema.ticketExternalRefs.created_at);
    const creatorIds = [...new Set(rows.map((r) => r.created_by))];
    const creators = creatorIds.length > 0
      ? await db.select().from(schema.users).where(inArray(schema.users.id, creatorIds))
      : [];
    const userById = new Map(creators.map((u) => [u.id, u]));
    const items = rows
      .map((r) => {
        const u = userById.get(r.created_by);
        return u ? mapExternalRef(r, u) : null;
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
    return c.json({ items }, 200);
  }) as any);

  // ─── create ──────────────────────────────────────────────────────────────
  app.openapi(create, (async (c: any) => {
    checkScope(c, "tickets:write");
    const { idOrKey: param } = c.req.valid("param");
    const body = c.req.valid("json");
    const auth = c.get("auth");

    const ticket = await resolveTicket(param);

    const kind = body.kind ?? detectKind(body.url);
    if (!urlMatchesKind(body.url, kind)) {
      throw badRequest(
        `URL doesn't match kind ${kind}. Pass kind: "generic" to skip URL validation.`,
      );
    }

    const inserted = await db.transaction(async (tx) => {
      const [created] = await catchUnique(
        "this ticket already has an external ref with that URL",
        () =>
          tx
            .insert(schema.ticketExternalRefs)
            .values({
              ticket_id: ticket.id,
              kind,
              url: body.url,
              created_by: auth.user.id,
            })
            .returning(),
      );
      if (!created) throw new Error("external_ref insert returned nothing");

      // Emit the added event so rules/subscriptions hear about it.
      const summary = await loadTicketSummary(ticket, tx as any);
      await writeEvent(tx as any, {
        event_type: "ticket.external_ref_added",
        actor: mapUserRef(auth.user),
        ticket: summary,
        project_id: ticket.project_id,
        extras: { external_ref_id: created.id, kind: created.kind, url: created.url },
      });

      return created;
    });

    return c.json(mapExternalRef(inserted, auth.user), 201);
  }) as any);

  // ─── delete ──────────────────────────────────────────────────────────────
  app.openapi(remove, (async (c: any) => {
    checkScope(c, "tickets:write");
    const { id } = c.req.valid("param");
    const auth = c.get("auth");

    const [existing] = await db.select().from(schema.ticketExternalRefs)
      .where(eq(schema.ticketExternalRefs.id, id)).limit(1);
    if (!existing) throw notFound("external ref");

    const [ticket] = await db.select().from(schema.tickets)
      .where(eq(schema.tickets.id, existing.ticket_id)).limit(1);
    if (!ticket) throw notFound("external ref");

    await db.transaction(async (tx) => {
      await tx.delete(schema.ticketExternalRefs).where(eq(schema.ticketExternalRefs.id, id));
      const summary = await loadTicketSummary(ticket, tx as any);
      await writeEvent(tx as any, {
        event_type: "ticket.external_ref_removed",
        actor: mapUserRef(auth.user),
        ticket: summary,
        project_id: ticket.project_id,
        extras: { external_ref_id: existing.id, kind: existing.kind, url: existing.url },
      });
    });

    return c.body(null, 204);
  }) as any);
}
