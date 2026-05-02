import { z } from "zod";
import { Uuid, Iso8601, SoftDeletable, ProjectKey, TicketKey } from "./common.js";
import { UserRef } from "./user.js";
import { ProjectRef } from "./project.js";
import { StatusRef, Resolution } from "./status.js";
import { LabelRef } from "./label.js";
import { Comment } from "./comment.js";
import { Attachment } from "./attachment.js";

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
    assignee: UserRef.nullable(),
    reporter: UserRef,
    due_date: Iso8601.nullable(),
    labels: z.array(LabelRef),
  })
  .merge(SoftDeletable);
export type TicketSummary = z.infer<typeof TicketSummary>;

// Full detail response — adds description, comments, all attachments.
export const Ticket = TicketSummary.extend({
  description: z.string(), // markdown, may be ""
  metadata: z.record(z.unknown()),
  comments: z.array(Comment),
  attachments: z.array(Attachment), // ticket-level attachments only
  all_attachments: z.array(Attachment), // ticket + all comment attachments, flattened
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

export const UpdateTicket = CreateTicket.omit({ project_key: true, type: true })
  .partial()
  .extend({
    label_ids: z.array(Uuid).optional(), // replaces full set when provided
  });
export type UpdateTicket = z.infer<typeof UpdateTicket>;

// Dedicated transition endpoint — validates against status_transitions table
// and enforces "epic can't close while non-closed children exist" guard.
export const TransitionTicket = z.object({
  status_id: Uuid,
  resolution: Resolution.optional(), // required when target status is `closed` category
  comment: z.string().max(50_000).optional(), // optional comment created atomically with the transition
});
export type TransitionTicket = z.infer<typeof TransitionTicket>;

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
  include_deleted: z.coerce.boolean().default(false),
});
export type TicketListFilters = z.infer<typeof TicketListFilters>;
