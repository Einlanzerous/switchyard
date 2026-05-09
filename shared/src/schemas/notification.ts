import { z } from "zod";
import { Uuid, Iso8601, paginated, Pagination } from "./common.js";
import { UserRef } from "./user.js";
import { TicketSummary } from "./ticket.js";

export const NotificationKind = z.enum(["mention"]);
export type NotificationKind = z.infer<typeof NotificationKind>;

export const NotificationSource = z.enum(["comment", "description"]);
export type NotificationSource = z.infer<typeof NotificationSource>;

// Persistent @mention notification. The 3.1 live-scan endpoint reused this
// shape implicitly (snippet + mentioned_at); this is the durable version.
//
// `ticket` is full TicketSummary so the dropdown can render type icons,
// keys, and titles without a follow-up fetch. `actor` is the commenter
// (or description editor) — null for system actions.

export const NotificationPayload = z.object({
  source: NotificationSource,
  snippet: z.string(),
  // actor is mirrored here from the top-level field so the bell dropdown
  // can render avatar/initials without joining users.
  actor: UserRef.nullable().optional(),
});

export const Notification = z.object({
  id: Uuid,
  kind: NotificationKind,
  actor: UserRef.nullable(),
  ticket: TicketSummary.nullable(),
  comment_id: Uuid.nullable(),
  payload: NotificationPayload,
  read_at: Iso8601.nullable(),
  created_at: Iso8601,
});
export type Notification = z.infer<typeof Notification>;

export const NotificationStatus = z.enum(["all", "unread"]);
export type NotificationStatus = z.infer<typeof NotificationStatus>;

export const ListNotificationsQuery = Pagination.extend({
  status: NotificationStatus.default("unread"),
  // Lower bound on `created_at`. Used by the homepage widget to scope the
  // visible badge count to a configurable window (default 14d there).
  since: Iso8601.optional(),
});
export type ListNotificationsQuery = z.infer<typeof ListNotificationsQuery>;

export const NotificationsPage = paginated(Notification);

export const MarkReadInput = z.union([
  z.object({ ids: z.array(Uuid).min(1) }),
  z.object({ all: z.literal(true) }),
]);
export type MarkReadInput = z.infer<typeof MarkReadInput>;

export const UnreadCount = z.object({
  count: z.number().int().nonnegative(),
});
export type UnreadCount = z.infer<typeof UnreadCount>;
