import { z } from "zod";
import { Uuid, Iso8601, SoftDeletable, ProjectKey, TicketKey } from "./common.js";
import { UserRef } from "./user.js";
import { ProjectRef } from "./project.js";
import { StatusRef, Resolution } from "./status.js";
import { LabelRef } from "./label.js";
import { Comment } from "./comment.js";
import { Attachment } from "./attachment.js";
import { TicketLink } from "./ticketLink.js";
import { ExternalRef } from "./externalRef.js";

export const TicketType = z.enum(["spike", "task", "bug", "epic"]);
export type TicketType = z.infer<typeof TicketType>;

export const Priority = z.enum(["low", "medium", "high", "critical"]);
export type Priority = z.infer<typeof Priority>;

// Compact shape used in list responses, embedded references, and webhook payloads.
export const TicketSummary = z
  .object({
    id: Uuid,
    key: TicketKey, // computed: `${project.key}-${number}`
    number: z.number().int().positive(),
    project: ProjectRef,
    type: TicketType,
    title: z.string().min(1).max(500),
    status: StatusRef,
    resolution: Resolution.nullable(),
    priority: Priority.nullable(),
    parent_id: Uuid.nullable(),
    parent: z.object({ id: Uuid, key: z.string(), title: z.string() }).nullable().optional(),
    assignee: UserRef.nullable(),
    reporter: UserRef,
    due_date: Iso8601.nullable(),
    labels: z.array(LabelRef),
    // Manual sort order within a column. Higher = closer to the top.
    // Newly-created tickets get epoch-ms-at-create; manual drag reorders
    // overwrite via fractional indexing.
    position: z.number().nullable(),
    // External refs (GitHub PR / issue / commit / Actions / generic).
    // Embedded so kanban cards can render badges without a follow-up
    // fetch. Typical ticket has 0-3 refs; the list endpoint batches
    // the fan-out so the cost is one extra query per page, not N+1.
    external_refs: z.array(ExternalRef),
    // Back-pointer to the ticket_template that materialized this ticket.
    // NULL = hand-created. Drawer surfaces a "Recurring" badge when set.
    template_id: Uuid.nullable(),
  })
  .merge(SoftDeletable);
export type TicketSummary = z.infer<typeof TicketSummary>;

// Full detail response — adds description, comments, all attachments, links.
export const Ticket = TicketSummary.extend({
  description: z.string(), // markdown, may be ""
  metadata: z.record(z.unknown()),
  comments: z.array(Comment),
  attachments: z.array(Attachment), // ticket-level attachments only
  all_attachments: z.array(Attachment), // ticket + all comment attachments, flattened
  links: z.array(TicketLink), // outgoing + incoming, tagged by direction
});
export type Ticket = z.infer<typeof Ticket>;

export const CreateTicket = z.object({
  project_key: ProjectKey,
  type: TicketType,
  title: z.string().min(1).max(500),
  description: z.string().max(100_000).optional(),
  status_id: Uuid.optional(), // defaults to project's default status
  priority: Priority.optional(),
  parent_id: Uuid.optional(), // must reference an epic in the same project; non-epic children only
  assignee_id: Uuid.optional(),
  due_date: Iso8601.optional(),
  label_ids: z.array(Uuid).optional(),
  metadata: z.record(z.unknown()).optional(),
});
export type CreateTicket = z.infer<typeof CreateTicket>;

// status_id is intentionally omitted: status changes are routed exclusively
// through POST /v1/tickets/{idOrKey}/transition, which enforces the
// transitions table and the epic-close guard. Use that endpoint for any
// status mutation; PATCH covers everything else.
//
// Nullable fields (assignee_id, parent_id, due_date) accept `null` to clear
// the existing value, since `undefined` already means "leave unchanged" in
// PATCH semantics. The handler already supports the null-clear path
// (server/src/routes/tickets.ts:495); the schema just needs to let it through.
export const UpdateTicket = CreateTicket.omit({ project_key: true, type: true, status_id: true })
  .partial()
  .extend({
    assignee_id: Uuid.nullable().optional(),
    parent_id: Uuid.nullable().optional(),
    due_date: Iso8601.nullable().optional(),
    label_ids: z.array(Uuid).optional(), // replaces full set when provided
    // Manual sort order. The drag-to-reorder UX computes a fractional value
    // between the new neighbors' positions; the server just stores it.
    position: z.number().optional(),
  });
export type UpdateTicket = z.infer<typeof UpdateTicket>;

// Dedicated transition endpoint — validates against status_transitions table
// and enforces "epic can't close while non-closed children exist" guard.
export const TransitionTicket = z.object({
  status_id: Uuid,
  resolution: Resolution.optional(), // required when target status is `closed` category
  comment: z.string().max(50_000).optional(), // optional comment created atomically with the transition
  // Optional manual position in the destination column. Cross-column drag
  // gestures use this to land the card at a specific index rather than the
  // top by default.
  position: z.number().optional(),
});
export type TransitionTicket = z.infer<typeof TransitionTicket>;

// Move a ticket to a different project. Allocates a new ticket number in
// the destination, remaps status (via fallback chain — exact name+category,
// then category alone, else 400 with candidates), and clears the parent
// when it doesn't carry over. The old key keeps resolving via
// ticket_aliases forever, so external systems that cached the prior key
// keep working.
export const MoveTicket = z.object({
  project_key: ProjectKey,
  // Optional explicit destination status. Required when status mapping
  // is ambiguous (multiple candidates in the destination project share
  // the source's category).
  status_id: Uuid.optional(),
  // Optional new parent in the destination project. Validated as an epic
  // in that project. When omitted and the source had a cross-project
  // parent, the parent is cleared (don't 400 the common case).
  parent_id: Uuid.nullable().optional(),
});
export type MoveTicket = z.infer<typeof MoveTicket>;

// Sort keys for GET /v1/tickets. Cross-board "what's due next" is the
// motivating use case; updated_at stays the default so existing callers
// keep their ordering.
export const TicketSortBy = z.enum(["updated_at", "due_date", "created_at", "priority"]);
export type TicketSortBy = z.infer<typeof TicketSortBy>;

export const TicketSortOrder = z.enum(["asc", "desc"]);
export type TicketSortOrder = z.infer<typeof TicketSortOrder>;

// Filters supported on GET /v1/tickets — agents use this heavily.
export const TicketListFilters = z.object({
  project: z.string().optional(), // project key OR comma-separated keys
  status: z.string().optional(), // status_id OR category name OR comma-separated mix
  type: z.string().optional(), // single type OR comma-separated
  label: z.string().optional(), // label_id OR comma-separated
  assignee: z.string().optional(), // user_id OR "unassigned"
  reporter: z.string().optional(),
  parent_id: z.string().optional(),
  text: z.string().optional(), // simple ILIKE on title + description
  updated_after: Iso8601.optional(),
  updated_before: Iso8601.optional(),
  // due_date filter — "overdue" excludes closed tickets, "this_week" is next 7
  // days (open only), "none" matches null due_date regardless of status.
  due: z.enum(["overdue", "this_week", "none"]).optional(),
  include_deleted: z.coerce.boolean().default(false),
  // Sort key + direction. Omitted = legacy behavior (updated_at DESC). When
  // sort_by is set without sort_order, the natural direction is used:
  // due_date / created_at ASC, updated_at / priority DESC. due_date and
  // priority sort NULLS LAST regardless of direction.
  sort_by: TicketSortBy.optional(),
  sort_order: TicketSortOrder.optional(),
});
export type TicketListFilters = z.infer<typeof TicketListFilters>;
