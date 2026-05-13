// Ticket loading helpers shared across the create / update / transition / get
// handlers. Each handler ends up needing the same fan-out of related data
// (project, status, assignee, reporter, labels, sometimes comments + attachments)
// so this module centralizes those reads.

import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import * as schema from "../../drizzle/schema.js";
import { db } from "../db.js";
import {
  mapTicket, mapTicketSummary, mapComment, mapAttachment, mapTicketLink, mapExternalRef,
  type TicketSummaryDeps,
} from "./mappers.js";
import type {
  Ticket as ApiTicket, TicketSummary as ApiTicketSummary,
  Comment as ApiComment, Attachment as ApiAttachment,
  TicketLink as ApiTicketLink, ExternalRef as ApiExternalRef,
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

  const externalRefs = await loadExternalRefsForTicket(ticket.id, tx);

  return {
    project, status, assignee, reporter,
    labels: labels.map((r) => r.label),
    number: ticket.number,
    externalRefs,
  };
}

// External refs for a single ticket. Fans out creators in one query so
// the response includes the UserRef inline. Used by single-ticket loads
// (create, update, transition, detail); the list endpoint uses its own
// batched fan-out below.
async function loadExternalRefsForTicket(ticketId: string, tx?: Tx): Promise<ApiExternalRef[]> {
  const q = tx ?? db;
  const rows = await q.select().from(schema.ticketExternalRefs)
    .where(eq(schema.ticketExternalRefs.ticket_id, ticketId))
    .orderBy(asc(schema.ticketExternalRefs.created_at));
  if (rows.length === 0) return [];
  const creatorIds = [...new Set(rows.map((r) => r.created_by))];
  const creators = await q.select().from(schema.users)
    .where(inArray(schema.users.id, creatorIds));
  const byId = new Map(creators.map((u) => [u.id, u]));
  return rows
    .map((r) => {
      const u = byId.get(r.created_by);
      return u ? mapExternalRef(r, u) : null;
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);
}

// Batched version for the tickets list. Returns a Map<ticket_id, ExternalRef[]>
// so callers can plug it into per-ticket deps without an N+1.
export async function fetchExternalRefsByTicket(
  ticketIds: string[],
): Promise<Map<string, ApiExternalRef[]>> {
  const result = new Map<string, ApiExternalRef[]>();
  if (ticketIds.length === 0) return result;
  const rows = await db.select().from(schema.ticketExternalRefs)
    .where(inArray(schema.ticketExternalRefs.ticket_id, ticketIds))
    .orderBy(asc(schema.ticketExternalRefs.created_at));
  if (rows.length === 0) return result;
  const creatorIds = [...new Set(rows.map((r) => r.created_by))];
  const creators = await db.select().from(schema.users)
    .where(inArray(schema.users.id, creatorIds));
  const userById = new Map(creators.map((u) => [u.id, u]));
  for (const r of rows) {
    const u = userById.get(r.created_by);
    if (!u) continue;
    const arr = result.get(r.ticket_id) ?? [];
    arr.push(mapExternalRef(r, u));
    result.set(r.ticket_id, arr);
  }
  return result;
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

  const links = await loadTicketLinks(ticket.id);

  return mapTicket(ticket, {
    ...summaryDeps,
    comments,
    ticketAttachments,
    commentAttachments,
    links,
  });
}

// All links touching this ticket, in either direction. Single query for
// rows (source = X OR target = X), then one fan-out for the "other"
// tickets, their projects, and the creators.
export async function loadTicketLinks(ticketId: string): Promise<ApiTicketLink[]> {
  const rows = await db
    .select()
    .from(schema.ticketLinks)
    .where(
      or(
        eq(schema.ticketLinks.source_ticket_id, ticketId),
        eq(schema.ticketLinks.target_ticket_id, ticketId),
      ),
    )
    .orderBy(asc(schema.ticketLinks.created_at));

  if (rows.length === 0) return [];

  const otherIds = [
    ...new Set(
      rows.map((r) => (r.source_ticket_id === ticketId ? r.target_ticket_id : r.source_ticket_id)),
    ),
  ];
  const creatorIds = [...new Set(rows.map((r) => r.created_by))];

  const [others, creators] = await Promise.all([
    db.select().from(schema.tickets).where(inArray(schema.tickets.id, otherIds)),
    db.select().from(schema.users).where(inArray(schema.users.id, creatorIds)),
  ]);

  const projectIds = [...new Set(others.map((t) => t.project_id))];
  const projects = await db.select().from(schema.projects).where(inArray(schema.projects.id, projectIds));

  const ticketById = new Map(others.map((t) => [t.id, t]));
  const projectById = new Map(projects.map((p) => [p.id, p]));
  const userById = new Map(creators.map((u) => [u.id, u]));

  const result: ApiTicketLink[] = [];
  for (const row of rows) {
    const otherId = row.source_ticket_id === ticketId ? row.target_ticket_id : row.source_ticket_id;
    const other = ticketById.get(otherId);
    const creator = userById.get(row.created_by);
    if (!other || !creator) continue; // dangling rows shouldn't happen (FKs), but be defensive
    const project = projectById.get(other.project_id);
    if (!project) continue;
    result.push(
      mapTicketLink(row, {
        viewingTicketId: ticketId,
        otherTicket: { id: other.id, number: other.number },
        otherProjectKey: project.key,
        otherTitle: other.title,
        creator,
      }),
    );
  }
  return result;
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
