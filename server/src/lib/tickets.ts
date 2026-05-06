// Ticket loading helpers shared across the create / update / transition / get
// handlers. Each handler ends up needing the same fan-out of related data
// (project, status, assignee, reporter, labels, sometimes comments + attachments)
// so this module centralizes those reads.

import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import * as schema from "../../drizzle/schema.js";
import { db } from "../db.js";
import {
  mapTicket, mapTicketSummary, mapComment, mapAttachment,
  type TicketSummaryDeps,
} from "./mappers.js";
import type {
  Ticket as ApiTicket, TicketSummary as ApiTicketSummary,
  Comment as ApiComment, Attachment as ApiAttachment,
} from "@switchyard/shared";
import { badRequest, notFound } from "../errors.js";

type TicketRow = typeof schema.tickets.$inferSelect;

// Drizzle's Postgres-js transaction object is structurally compatible with
// `db` for the read shapes we use here. Loosely typed on purpose — exporting
// the precise type would require dragging the dialect types around the codebase.
type Tx = typeof db;

// Fan out the lookups every ticket-shape handler needs. Keeps the n+1 vs.
// single-query tradeoff explicit: this is N=1 (single ticket); the list
// handler in routes/tickets.ts does its own batched joins.
//
// `tx` is optional — pass it when calling from inside a transaction so reads
// see in-flight writes (e.g. ticket_labels just inserted). Without it, reads
// use the global pool and only see committed data.
async function loadTicketSummaryDeps(ticket: TicketRow, tx?: Tx): Promise<TicketSummaryDeps> {
  const q = tx ?? db;
  const [project] = await q.select().from(schema.projects).where(eq(schema.projects.id, ticket.project_id)).limit(1);
  if (!project) throw badRequest("orphan ticket: project missing");

  const [status] = await q.select().from(schema.statuses).where(eq(schema.statuses.id, ticket.status_id)).limit(1);
  if (!status) throw badRequest("orphan ticket: status missing");

  const [reporter] = await q.select().from(schema.users).where(eq(schema.users.id, ticket.reporter_id)).limit(1);
  if (!reporter) throw badRequest("orphan ticket: reporter missing");

  const assignee = ticket.assignee_id
    ? (await q.select().from(schema.users).where(eq(schema.users.id, ticket.assignee_id)).limit(1))[0] ?? null
    : null;

  const labels = await q.select({ label: schema.labels })
    .from(schema.ticketLabels)
    .innerJoin(schema.labels, eq(schema.ticketLabels.label_id, schema.labels.id))
    .where(eq(schema.ticketLabels.ticket_id, ticket.id));

  return {
    project, status, assignee, reporter,
    labels: labels.map((r) => r.label),
    number: ticket.number,
  };
}

export async function loadTicketSummary(ticket: TicketRow, tx?: Tx): Promise<ApiTicketSummary> {
  const deps = await loadTicketSummaryDeps(ticket, tx);
  return mapTicketSummary(ticket, deps);
}

export async function loadTicketDetail(ticket: TicketRow, tx?: Tx): Promise<ApiTicket> {
  void tx; // detail is currently always called post-commit; future txn callers can wire this
  const summaryDeps = await loadTicketSummaryDeps(ticket);

  // Comments + author lookups.
  const commentRows = await db.select().from(schema.comments)
    .where(and(eq(schema.comments.ticket_id, ticket.id), isNull(schema.comments.deleted_at)))
    .orderBy(asc(schema.comments.created_at));
  const commentIds = commentRows.map((c) => c.id);

  const authorIds = [...new Set(commentRows.map((c) => c.author_id))];
  const authors = authorIds.length > 0
    ? await db.select().from(schema.users).where(inArray(schema.users.id, authorIds))
    : [];
  const authorById = new Map(authors.map((a) => [a.id, a]));

  // Attachments — both ticket-level and comment-level — in one query.
  const attachmentRows = await db.select().from(schema.attachments).where(
    or(
      eq(schema.attachments.ticket_id, ticket.id),
      commentIds.length > 0 ? inArray(schema.attachments.comment_id, commentIds) : sql`false`,
    )!
  );
  const uploaderIds = [...new Set(attachmentRows.map((a) => a.uploaded_by))];
  const uploaders = uploaderIds.length > 0
    ? await db.select().from(schema.users).where(inArray(schema.users.id, uploaderIds))
    : [];
  const uploaderById = new Map(uploaders.map((u) => [u.id, u]));

  const ticketAttachments: ApiAttachment[] = [];
  const commentAttachmentsByComment = new Map<string, ApiAttachment[]>();
  for (const a of attachmentRows) {
    const uploader = uploaderById.get(a.uploaded_by);
    if (!uploader) continue;
    const mapped = mapAttachment(a, uploader);
    if (a.ticket_id && !a.comment_id) ticketAttachments.push(mapped);
    else if (a.comment_id) {
      const list = commentAttachmentsByComment.get(a.comment_id) ?? [];
      list.push(mapped);
      commentAttachmentsByComment.set(a.comment_id, list);
    }
  }

  const comments: ApiComment[] = commentRows.map((cr) => {
    const author = authorById.get(cr.author_id);
    if (!author) throw badRequest("orphan comment: author missing");
    return mapComment(cr, author, commentAttachmentsByComment.get(cr.id) ?? []);
  });

  const commentAttachments = [...commentAttachmentsByComment.values()].flat();

  return mapTicket(ticket, {
    ...summaryDeps,
    comments,
    ticketAttachments,
    commentAttachments,
  });
}

// Increment the per-project counter inside a transaction. Returns the new
// ticket's number. Bulletproof against concurrent inserts because Postgres
// serializes the UPDATE on the same row.
export async function allocateTicketNumber(
  tx: any,
  projectId: string
): Promise<number> {
  const result = await tx
    .update(schema.projectCounters)
    .set({ last_used_number: sql`${schema.projectCounters.last_used_number} + 1` })
    .where(eq(schema.projectCounters.project_id, projectId))
    .returning({ last_used_number: schema.projectCounters.last_used_number });
  const row = (result as Array<{ last_used_number: number }>)[0];
  if (!row) throw notFound(`project_counters row for project ${projectId}`);
  return row.last_used_number;
}
