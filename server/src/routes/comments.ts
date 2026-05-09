import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { and, eq, inArray, isNull, type SQL } from "drizzle-orm";
import { Comment, CreateComment, UpdateComment, Uuid, paginated, Pagination, type Attachment as ApiAttachment } from "@switchyard/shared";
import { db } from "../db.js";
import * as schema from "../../drizzle/schema.js";
import { requireAuth } from "../auth.js";
import { idempotency } from "../lib/idempotency.js";
import { errorResponses, okJson, createdJson, noContent, checkScope, z, idempotencyHeader } from "./_helpers.js";
import { mapComment, mapAttachment, mapUserRef } from "../lib/mappers.js";
import { resolveTicket } from "../lib/lookups.js";
import { buildPage, cursorOrderBy, cursorWhere, decodeCursor } from "../lib/pagination.js";
import { writeEvent } from "../lib/events.js";
import { loadTicketSummary } from "../lib/tickets.js";
import { detectAndNotify, detectAndNotifyOnEdit } from "../lib/mentions.js";
import { badRequest, notFound } from "../errors.js";

const tag = "Comments";
const idOrKey = z.string().min(1);

const list = createRoute({
  method: "get", path: "/v1/tickets/{idOrKey}/comments", tags: [tag], summary: "List comments on a ticket",
  request: { params: z.object({ idOrKey }), query: Pagination },
  responses: { ...okJson(paginated(Comment)), ...errorResponses },
});

const create = createRoute({
  method: "post", path: "/v1/tickets/{idOrKey}/comments", tags: [tag], summary: "Create a comment",
  request: {
    params: z.object({ idOrKey }),
    headers: idempotencyHeader,
    body: { content: { "application/json": { schema: CreateComment } } },
  },
  responses: { ...createdJson(Comment), ...errorResponses },
});

const update = createRoute({
  method: "patch", path: "/v1/comments/{id}", tags: [tag], summary: "Update a comment",
  request: {
    params: z.object({ id: Uuid }),
    body: { content: { "application/json": { schema: UpdateComment } } },
  },
  responses: { ...okJson(Comment), ...errorResponses },
});

const remove = createRoute({
  method: "delete", path: "/v1/comments/{id}", tags: [tag], summary: "Soft-delete a comment",
  request: { params: z.object({ id: Uuid }) },
  responses: { ...noContent, ...errorResponses },
});

export function mount(app: OpenAPIHono) {
  app.use("/v1/comments/*", requireAuth);
  app.use("/v1/comments/*", idempotency);

  // List comments on a ticket. Lives under /v1/tickets/* per the public route
  // but is owned by this module for cohesion with the comment mutations.
  app.openapi(list, (async (c: any) => {
    const { idOrKey: param } = c.req.valid("param");
    const q = c.req.valid("query");
    const limit = q.limit;
    const ticket = await resolveTicket(param);

    const conds: SQL[] = [
      eq(schema.comments.ticket_id, ticket.id),
      isNull(schema.comments.deleted_at),
    ];
    if (q.cursor) {
      const cur = decodeCursor(q.cursor);
      if (!cur) throw badRequest("invalid cursor");
      conds.push(cursorWhere(schema.comments.updated_at, schema.comments.id, cur));
    }

    const rows = await db.select().from(schema.comments)
      .where(and(...conds))
      .orderBy(...cursorOrderBy(schema.comments.updated_at, schema.comments.id))
      .limit(limit + 1);

    const authorIds = [...new Set(rows.map((r) => r.author_id))];
    const commentIds = rows.map((r) => r.id);

    const authors = authorIds.length > 0
      ? await db.select().from(schema.users).where(inArray(schema.users.id, authorIds))
      : [];
    const authorById = new Map(authors.map((a) => [a.id, a]));

    const attachmentRows = commentIds.length > 0
      ? await db.select().from(schema.attachments).where(inArray(schema.attachments.comment_id, commentIds))
      : [];
    const uploaderIds = [...new Set(attachmentRows.map((a) => a.uploaded_by))];
    const uploaders = uploaderIds.length > 0
      ? await db.select().from(schema.users).where(inArray(schema.users.id, uploaderIds))
      : [];
    const uploaderById = new Map(uploaders.map((u) => [u.id, u]));

    const attachmentsByComment = new Map<string, ApiAttachment[]>();
    for (const a of attachmentRows) {
      if (!a.comment_id) continue;
      const uploader = uploaderById.get(a.uploaded_by);
      if (!uploader) continue;
      const arr = attachmentsByComment.get(a.comment_id) ?? [];
      arr.push(mapAttachment(a, uploader));
      attachmentsByComment.set(a.comment_id, arr);
    }

    const comments = rows.map((r) => {
      const author = authorById.get(r.author_id);
      if (!author) throw badRequest("orphan comment: author missing");
      return mapComment(r, author, attachmentsByComment.get(r.id) ?? []);
    });

    return c.json(buildPage(comments, limit), 200);
  }) as any);

  // Create comment.
  app.openapi(create, (async (c: any) => {
    checkScope(c, "comments:write");
    const { idOrKey: param } = c.req.valid("param");
    const body = c.req.valid("json");
    const auth = c.get("auth");
    const ticket = await resolveTicket(param);

    const inserted = await db.transaction(async (tx) => {
      const [created] = await tx.insert(schema.comments).values({
        ticket_id: ticket.id,
        author_id: auth.user.id,
        body: body.body,
      }).returning();
      if (!created) throw new Error("comment insert returned nothing");

      const summary = await loadTicketSummary(ticket, tx as any);
      await writeEvent(tx as any, {
        event_type: "comment.created",
        actor: mapUserRef(auth.user),
        ticket: summary,
        project_id: ticket.project_id,
        extras: { comment_id: created.id, comment_body: created.body },
      });

      // @mention notifications. Self-mentions DO notify (intentional —
      // matches the user's "@-myself to remember" workflow).
      await detectAndNotify(tx as any, {
        text: created.body,
        actor: auth.user,
        ticket_id: ticket.id,
        comment_id: created.id,
        source: "comment",
      });

      return created;
    });

    return c.json(mapComment(inserted, auth.user, []), 201);
  }) as any);

  // Update comment.
  app.openapi(update, (async (c: any) => {
    checkScope(c, "comments:write");
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const auth = c.get("auth");

    const [existing] = await db.select().from(schema.comments)
      .where(and(eq(schema.comments.id, id), isNull(schema.comments.deleted_at)))
      .limit(1);
    if (!existing) throw notFound("comment");

    if (body.body === undefined) {
      const author = (await db.select().from(schema.users).where(eq(schema.users.id, existing.author_id)).limit(1))[0]!;
      const att = await db.select().from(schema.attachments).where(eq(schema.attachments.comment_id, id));
      const uploaders = att.length > 0
        ? await db.select().from(schema.users).where(inArray(schema.users.id, [...new Set(att.map((a) => a.uploaded_by))]))
        : [];
      const upBy = new Map(uploaders.map((u) => [u.id, u]));
      const mapped = att.map((a) => mapAttachment(a, upBy.get(a.uploaded_by)!)).filter(Boolean);
      return c.json(mapComment(existing, author, mapped), 200);
    }

    const updated = await db.transaction(async (tx) => {
      const [u] = await tx.update(schema.comments)
        .set({ body: body.body })
        .where(eq(schema.comments.id, id))
        .returning();
      if (!u) throw notFound("comment");

      const ticket = (await tx.select().from(schema.tickets).where(eq(schema.tickets.id, u.ticket_id)).limit(1))[0]!;
      const summary = await loadTicketSummary(ticket, tx as any);
      await writeEvent(tx as any, {
        event_type: "comment.updated",
        actor: mapUserRef(auth.user),
        ticket: summary,
        project_id: ticket.project_id,
        extras: { comment_id: u.id },
      });

      // Diff-aware notifications: only fire for users newly @mentioned in
      // the edited body. Re-edits to the same set are no-ops.
      await detectAndNotifyOnEdit(tx as any, {
        oldText: existing.body,
        newText: u.body,
        actor: auth.user,
        ticket_id: ticket.id,
        comment_id: u.id,
        source: "comment",
      });

      return u;
    });

    const author = (await db.select().from(schema.users).where(eq(schema.users.id, updated.author_id)).limit(1))[0]!;
    const att = await db.select().from(schema.attachments).where(eq(schema.attachments.comment_id, id));
    const uploaders = att.length > 0
      ? await db.select().from(schema.users).where(inArray(schema.users.id, [...new Set(att.map((a) => a.uploaded_by))]))
      : [];
    const upBy = new Map(uploaders.map((u) => [u.id, u]));
    const mapped = att.map((a) => mapAttachment(a, upBy.get(a.uploaded_by)!)).filter(Boolean);
    return c.json(mapComment(updated, author, mapped), 200);
  }) as any);

  // Soft-delete comment.
  app.openapi(remove, (async (c: any) => {
    checkScope(c, "comments:write");
    const { id } = c.req.valid("param");
    const auth = c.get("auth");

    const [existing] = await db.select().from(schema.comments)
      .where(and(eq(schema.comments.id, id), isNull(schema.comments.deleted_at)))
      .limit(1);
    if (!existing) throw notFound("comment");

    const ticket = (await db.select().from(schema.tickets).where(eq(schema.tickets.id, existing.ticket_id)).limit(1))[0]!;
    const summary = await loadTicketSummary(ticket);

    await db.transaction(async (tx) => {
      await tx.update(schema.comments)
        .set({ deleted_at: new Date().toISOString() })
        .where(eq(schema.comments.id, id));

      await writeEvent(tx as any, {
        event_type: "comment.deleted",
        actor: mapUserRef(auth.user),
        ticket: summary,
        project_id: ticket.project_id,
        extras: { comment_id: id },
      });
    });

    return c.body(null, 204);
  }) as any);
}
