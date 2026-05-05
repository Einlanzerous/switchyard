// DB row → API shape transforms.
//
// Centralized so the same mapping is used by list and detail handlers, and
// so the API contract surface stays in one place to audit.

import type {
  User, UserRef, Project, ProjectRef, Status, StatusRef,
  Label, LabelRef, TicketSummary, Ticket, Comment, Attachment, Event as ApiEvent,
  Resolution, TicketType, Priority, EventType, AttachmentKind, StatusCategory,
  ApiToken,
} from "@switchyard/shared";
import * as schema from "../../drizzle/schema.js";
import { env } from "../env.js";

type UserRow = typeof schema.users.$inferSelect;
type ProjectRow = typeof schema.projects.$inferSelect;
type StatusRow = typeof schema.statuses.$inferSelect;
type LabelRow = typeof schema.labels.$inferSelect;
type TicketRow = typeof schema.tickets.$inferSelect;
type CommentRow = typeof schema.comments.$inferSelect;
type AttachmentRow = typeof schema.attachments.$inferSelect;
type EventRow = typeof schema.events.$inferSelect;
type TokenRow = typeof schema.apiTokens.$inferSelect;

// ─── users ─────────────────────────────────────────────────────────────────

export function mapUser(u: UserRow): User {
  return {
    id: u.id,
    name: u.name,
    icon: u.icon,
    type: u.type,
    created_at: u.created_at,
    updated_at: u.updated_at,
    deleted_at: u.deleted_at,
  };
}

export function mapUserRef(u: UserRow): UserRef {
  return { id: u.id, name: u.name, icon: u.icon, type: u.type };
}

// ─── projects ──────────────────────────────────────────────────────────────

export function mapProject(p: ProjectRow): Project {
  return {
    id: p.id,
    key: p.key,
    name: p.name,
    description: p.description,
    color: p.color,
    archived_at: p.archived_at,
    created_at: p.created_at,
    updated_at: p.updated_at,
    deleted_at: p.deleted_at,
  };
}

export function mapProjectRef(p: ProjectRow): ProjectRef {
  return { id: p.id, key: p.key, name: p.name, color: p.color };
}

// ─── statuses ──────────────────────────────────────────────────────────────

export function mapStatus(s: StatusRow): Status {
  return {
    id: s.id,
    project_id: s.project_id,
    category: s.category as StatusCategory,
    display_name: s.display_name,
    position: s.position,
    is_default: s.is_default,
    created_at: s.created_at,
    updated_at: s.updated_at,
  };
}

export function mapStatusRef(s: StatusRow): StatusRef {
  return {
    id: s.id,
    category: s.category as StatusCategory,
    display_name: s.display_name,
  };
}

// ─── labels ────────────────────────────────────────────────────────────────

export function mapLabel(l: LabelRow): Label {
  return {
    id: l.id,
    project_id: l.project_id,
    name: l.name,
    color: l.color,
    created_at: l.created_at,
    updated_at: l.updated_at,
  };
}

export function mapLabelRef(l: LabelRow): LabelRef {
  return { id: l.id, name: l.name, color: l.color };
}

// ─── attachments ───────────────────────────────────────────────────────────

export function mapAttachment(a: AttachmentRow, uploader: UserRow): Attachment {
  return {
    id: a.id,
    ticket_id: a.ticket_id,
    comment_id: a.comment_id,
    kind: a.kind as AttachmentKind,
    mime_type: a.mime_type,
    size_bytes: a.size_bytes,
    original_name: a.original_name,
    url: `${env.PUBLIC_URL}/v1/attachments/${a.id}`,
    transcript: a.transcript,
    uploaded_by: mapUserRef(uploader),
    created_at: a.created_at,
  };
}

// ─── comments ──────────────────────────────────────────────────────────────

export function mapComment(c: CommentRow, author: UserRow, attachments: Attachment[]): Comment {
  return {
    id: c.id,
    ticket_id: c.ticket_id,
    author: mapUserRef(author),
    body: c.body,
    attachments,
    created_at: c.created_at,
    updated_at: c.updated_at,
    deleted_at: c.deleted_at,
  };
}

// ─── tickets ───────────────────────────────────────────────────────────────

export type TicketSummaryDeps = {
  project: ProjectRow;
  status: StatusRow;
  assignee: UserRow | null;
  reporter: UserRow;
  labels: LabelRow[];
  number: number;
};

export function mapTicketSummary(t: TicketRow, deps: TicketSummaryDeps): TicketSummary {
  return {
    id: t.id,
    key: `${deps.project.key}-${t.number}`,
    number: t.number,
    project: mapProjectRef(deps.project),
    type: t.type as TicketType,
    title: t.title,
    status: mapStatusRef(deps.status),
    resolution: (t.resolution ?? null) as Resolution | null,
    priority: (t.priority ?? null) as Priority | null,
    parent_id: t.parent_id,
    assignee: deps.assignee ? mapUserRef(deps.assignee) : null,
    reporter: mapUserRef(deps.reporter),
    due_date: t.due_date,
    labels: deps.labels.map(mapLabelRef),
    created_at: t.created_at,
    updated_at: t.updated_at,
    deleted_at: t.deleted_at,
  };
}

export type TicketDetailDeps = TicketSummaryDeps & {
  comments: Comment[];
  ticketAttachments: Attachment[];
  commentAttachments: Attachment[];
};

export function mapTicket(t: TicketRow, deps: TicketDetailDeps): Ticket {
  const summary = mapTicketSummary(t, deps);
  const all = [...deps.ticketAttachments, ...deps.commentAttachments].sort((a, b) =>
    a.created_at < b.created_at ? -1 : 1
  );
  return {
    ...summary,
    description: t.description,
    metadata: (t.metadata as Record<string, unknown>) ?? {},
    comments: deps.comments,
    attachments: deps.ticketAttachments,
    all_attachments: all,
  };
}

// ─── events ────────────────────────────────────────────────────────────────

// events.payload contains the snapshot we wrote in writeEvent: { actor, ticket, changes, ...extras }
type EventPayload = {
  actor?: UserRef | null;
  ticket?: TicketSummary | null;
  changes?: ApiEvent["changes"];
  [k: string]: unknown;
};

export function mapEvent(e: EventRow): ApiEvent {
  const p = (e.payload ?? {}) as EventPayload;
  // The webhook envelope adds occurred_at = now() at delivery time, but the
  // events API surfaces created_at directly.
  return {
    id: e.id,
    event: e.event_type as EventType,
    occurred_at: e.created_at,
    actor: (p.actor ?? null) as UserRef | null,
    ticket: (p.ticket ?? null) as TicketSummary | null,
    changes: p.changes,
    payload: stripEnvelopeFields(p),
  };
}

function stripEnvelopeFields(p: EventPayload): Record<string, unknown> | undefined {
  const { actor, ticket, changes, ...rest } = p;
  void actor;
  void ticket;
  void changes;
  return Object.keys(rest).length > 0 ? rest : undefined;
}

// ─── api tokens ────────────────────────────────────────────────────────────

export function mapApiToken(t: TokenRow): ApiToken {
  return {
    id: t.id,
    user_id: t.user_id,
    name: t.name,
    scopes: t.scopes as ApiToken["scopes"],
    last_used_at: t.last_used_at,
    revoked_at: t.revoked_at,
    created_at: t.created_at,
    updated_at: t.updated_at,
  };
}
