import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { and, eq, isNull } from "drizzle-orm";
import { Attachment, AttachmentKind, Uuid } from "@switchyard/shared";
import { db } from "../db.js";
import * as schema from "../../drizzle/schema.js";
import { requireAuth } from "../auth.js";
import { idempotency } from "../lib/idempotency.js";
import { errorResponses, okJson, createdJson, noContent, checkScope, z } from "./_helpers.js";
import { mapAttachment, mapUserRef } from "../lib/mappers.js";
import { getUserById, resolveTicket } from "../lib/lookups.js";
import { writeEvent } from "../lib/events.js";
import { loadTicketSummary } from "../lib/tickets.js";
import {
  resolveSniff, checkSizeCap, buildStoragePath, writeBytes, unlinkSafe, safeResolve,
} from "../lib/attachments.js";
import { assertInstanceAdmin, assertProjectReadable, assertProjectRole } from "../lib/authz.js";
import { badRequest, notFound, unprocessable } from "../errors.js";

const tag = "Attachments";
const idOrKey = z.string().min(1);

const MultipartUpload = z.object({
  file: z.any(),
  kind: AttachmentKind,
  comment_id: Uuid.optional(),
  transcript: z.string().optional(),
});

const upload = createRoute({
  method: "post", path: "/v1/tickets/{idOrKey}/attachments", tags: [tag],
  summary: "Upload an attachment to a ticket (or a comment via comment_id form field)",
  request: {
    params: z.object({ idOrKey }),
    body: { content: { "multipart/form-data": { schema: MultipartUpload } } },
  },
  responses: { ...createdJson(Attachment), ...errorResponses },
});

const download = createRoute({
  method: "get", path: "/v1/attachments/{id}", tags: [tag],
  summary: "Download an attachment file (token-guarded; streams the bytes)",
  request: { params: z.object({ id: Uuid }) },
  responses: {
    200: { description: "file bytes", content: { "application/octet-stream": { schema: z.any() } } },
    ...errorResponses,
  },
});

const remove = createRoute({
  method: "delete", path: "/v1/attachments/{id}", tags: [tag], summary: "Delete an attachment",
  request: { params: z.object({ id: Uuid }) },
  responses: { ...noContent, ...errorResponses },
});

const meta = createRoute({
  method: "get", path: "/v1/attachments/{id}/meta", tags: [tag],
  summary: "Get attachment metadata (no file bytes)",
  request: { params: z.object({ id: Uuid }) },
  responses: { ...okJson(Attachment), ...errorResponses },
});

// Resolve an attachment's owning project by walking up to its parent ticket —
// directly via `ticket_id`, or through its `comment_id` to the comment's ticket.
// Inherited-resource reads (6.1.1) gate on THIS project, never the attachment
// row in isolation. Returns null when the chain can't resolve (orphan row).
async function attachmentProjectId(
  row: typeof schema.attachments.$inferSelect,
): Promise<string | null> {
  if (row.ticket_id) {
    const [t] = await db.select({ pid: schema.tickets.project_id })
      .from(schema.tickets).where(eq(schema.tickets.id, row.ticket_id)).limit(1);
    return t?.pid ?? null;
  }
  if (row.comment_id) {
    const [t] = await db.select({ pid: schema.tickets.project_id })
      .from(schema.comments)
      .innerJoin(schema.tickets, eq(schema.comments.ticket_id, schema.tickets.id))
      .where(eq(schema.comments.id, row.comment_id)).limit(1);
    return t?.pid ?? null;
  }
  return null;
}

export function mount(app: OpenAPIHono) {
  app.use("/v1/attachments/*", requireAuth);
  app.use("/v1/attachments/*", idempotency);

  app.openapi(meta, (async (c: any) => {
    const { id } = c.req.valid("param");
    const [row] = await db.select().from(schema.attachments).where(eq(schema.attachments.id, id)).limit(1);
    if (!row) throw notFound("attachment");
    const pid = await attachmentProjectId(row);
    if (!pid) throw notFound("attachment");
    await assertProjectReadable(c.get("auth").user, pid, "attachment");
    const uploader = await getUserById(row.uploaded_by);
    return c.json(mapAttachment(row, uploader), 200);
  }) as any);

  app.openapi(upload, (async (c: any) => {
    checkScope(c, "attachments:write");
    const { idOrKey: param } = c.req.valid("param");
    const auth = c.get("auth");
    const ticket = await resolveTicket(param);
    await assertProjectRole(auth.user, ticket.project_id, "write", "attachment");

    // We parse the multipart body manually rather than via c.req.valid("form")
    // because @hono/zod-openapi doesn't yet bind file fields cleanly.
    const form = await c.req.parseBody({ all: false });
    const file = form.file;
    const claimedKind = form.kind as string | undefined;
    const commentId = form.comment_id as string | undefined;
    const transcript = form.transcript as string | undefined;

    if (!file || typeof file === "string" || !(file instanceof File || (file as any).arrayBuffer)) {
      throw badRequest("missing or invalid 'file' field in multipart body");
    }
    if (claimedKind !== "image" && claimedKind !== "audio" && claimedKind !== "text") {
      throw badRequest("'kind' field must be one of: image, audio, text");
    }

    if (transcript !== undefined && claimedKind !== "audio") {
      throw badRequest("transcript is only allowed on audio attachments");
    }

    // Validate comment_id belongs to this ticket if provided.
    if (commentId) {
      const [comment] = await db.select().from(schema.comments)
        .where(and(eq(schema.comments.id, commentId), isNull(schema.comments.deleted_at)))
        .limit(1);
      if (!comment) throw notFound("comment");
      if (comment.ticket_id !== ticket.id) throw badRequest("comment does not belong to this ticket");
    }

    // Read into memory, sniff, size-check.
    const ab = await (file as File).arrayBuffer();
    const bytes = new Uint8Array(ab);
    if (bytes.byteLength === 0) throw unprocessable("uploaded file is empty");

    checkSizeCap(claimedKind as any, bytes.byteLength);
    const sniff = resolveSniff(bytes, claimedKind as any, (file as File).name);

    const storagePath = buildStoragePath(sniff.ext);
    await writeBytes(storagePath, bytes);

    let inserted: typeof schema.attachments.$inferSelect;
    try {
      inserted = await db.transaction(async (tx) => {
        const [a] = await tx.insert(schema.attachments).values({
          ticket_id: commentId ? null : ticket.id,
          comment_id: commentId ?? null,
          kind: sniff.kind,
          mime_type: sniff.mime,
          size_bytes: bytes.byteLength,
          storage_path: storagePath,
          original_name: (file as File).name || null,
          transcript: transcript ?? null,
          uploaded_by: auth.user.id,
        }).returning();
        if (!a) throw new Error("attachment insert returned nothing");

        const summary = await loadTicketSummary(ticket);
        await writeEvent(tx as any, {
          event_type: "attachment.added",
          actor: mapUserRef(auth.user),
          ticket: summary,
          project_id: ticket.project_id,
          extras: {
            attachment_id: a.id,
            kind: a.kind,
            comment_id: a.comment_id,
          },
        });
        return a;
      });
    } catch (err) {
      // DB write failed — clean up the file we already wrote so we don't leak.
      await unlinkSafe(storagePath);
      throw err;
    }

    return c.json(mapAttachment(inserted, auth.user), 201);
  }) as any);

  app.openapi(download, (async (c: any) => {
    const { id } = c.req.valid("param");
    const [row] = await db.select().from(schema.attachments).where(eq(schema.attachments.id, id)).limit(1);
    if (!row) throw notFound("attachment");
    // A direct file-id fetch must 404 for non-members — resolve up to the
    // parent ticket's project first (6.1.1).
    const pid = await attachmentProjectId(row);
    if (!pid) throw notFound("attachment");
    await assertProjectReadable(c.get("auth").user, pid, "attachment");

    const abs = safeResolve(row.storage_path);
    const file = Bun.file(abs);
    if (!(await file.exists())) throw notFound("attachment file");

    return new Response(file.stream(), {
      status: 200,
      headers: {
        "Content-Type": row.mime_type,
        "Content-Length": String(row.size_bytes),
        "Content-Disposition": `attachment; filename="${(row.original_name ?? row.id).replace(/"/g, "")}"`,
        "Cache-Control": "private, max-age=3600",
      },
    });
  }) as any);

  app.openapi(remove, (async (c: any) => {
    checkScope(c, "attachments:write");
    const { id } = c.req.valid("param");
    const auth = c.get("auth");

    const [existing] = await db.select().from(schema.attachments).where(eq(schema.attachments.id, id)).limit(1);
    if (!existing) throw notFound("attachment");

    // Resolve the parent ticket (directly or via comment) for the event payload.
    let ticketId: string | null = existing.ticket_id;
    if (!ticketId && existing.comment_id) {
      const [c2] = await db.select({ ticket_id: schema.comments.ticket_id })
        .from(schema.comments).where(eq(schema.comments.id, existing.comment_id)).limit(1);
      ticketId = c2?.ticket_id ?? null;
    }
    const ticket = ticketId
      ? (await db.select().from(schema.tickets).where(eq(schema.tickets.id, ticketId)).limit(1))[0]
      : null;

    // Gate on the parent ticket's project; an orphan attachment (no ticket nor
    // resolvable comment) has no project, so it's instance-admin only.
    if (ticket) await assertProjectRole(auth.user, ticket.project_id, "write", "attachment");
    else assertInstanceAdmin(auth.user, "attachment");

    await db.transaction(async (tx) => {
      await tx.delete(schema.attachments).where(eq(schema.attachments.id, id));
      if (ticket) {
        const summary = await loadTicketSummary(ticket);
        await writeEvent(tx as any, {
          event_type: "attachment.removed",
          actor: mapUserRef(auth.user),
          ticket: summary,
          project_id: ticket.project_id,
          extras: { attachment_id: id, kind: existing.kind },
        });
      }
    });

    // Best-effort file unlink. If this fails the row is already gone; we just
    // leak disk. A periodic janitor in milestone 1.6 would sweep orphans.
    await unlinkSafe(safeResolve(existing.storage_path));

    return c.body(null, 204);
  }) as any);
}
