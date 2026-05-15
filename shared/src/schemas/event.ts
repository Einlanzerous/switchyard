import { z } from "zod";
import { Uuid, Iso8601 } from "./common.js";
import { UserRef } from "./user.js";
import { TicketSummary } from "./ticket.js";
import { StatusRef, Resolution } from "./status.js";

export const EventType = z.enum([
  "ticket.created",
  "ticket.updated",
  "ticket.status_changed",
  "ticket.assigned",
  "ticket.closed",
  "ticket.released",
  "ticket.deleted",
  "ticket.moved",
  "ticket.link_added",
  "ticket.link_removed",
  "ticket.external_ref_added",
  "ticket.external_ref_removed",
  "ticket.external_ref_state_changed",
  "comment.created",
  "comment.updated",
  "comment.deleted",
  "attachment.added",
  "attachment.removed",
  "project.created",
  "project.updated",
  "project.deleted",
]);
export type EventType = z.infer<typeof EventType>;

// Diff payload — populated for ticket.updated and ticket.status_changed.
export const FieldChange = z.object({
  field: z.string(),
  from: z.unknown().nullable(),
  to: z.unknown().nullable(),
});
export type FieldChange = z.infer<typeof FieldChange>;

export const StatusChange = z.object({
  from: StatusRef.nullable(),
  to: StatusRef,
  resolution: Resolution.nullable().optional(),
});
export type StatusChange = z.infer<typeof StatusChange>;

export const EventChanges = z
  .object({
    fields: z.array(FieldChange).optional(),
    status: StatusChange.optional(),
  })
  .partial();
export type EventChanges = z.infer<typeof EventChanges>;

// Single envelope used both for the events API and outbound webhooks.
export const Event = z.object({
  id: Uuid,
  event: EventType,
  occurred_at: Iso8601,
  actor: UserRef.nullable(), // null for system-triggered events
  ticket: TicketSummary.nullable(), // null for project-level events
  changes: EventChanges.optional(),
  payload: z.record(z.unknown()).optional(), // event-specific extras (comment body, attachment id, etc.)
});
export type Event = z.infer<typeof Event>;
