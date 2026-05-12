import { z } from "zod";
import { Uuid, Iso8601, TicketKey } from "./common.js";
import { UserRef } from "./user.js";

// Typed cross-ticket relations. Distinct from `parent_id` (epic→child,
// enforced by trigger). Stored once from the source side; the GET
// handler unions source + target queries and tags each row with its
// direction so the UI can pick the right verb.

export const TicketLinkType = z.enum(["blocks", "relates_to", "duplicates"]);
export type TicketLinkType = z.infer<typeof TicketLinkType>;

// "outgoing" = this ticket is the source (renders forward verb)
// "incoming" = this ticket is the target (renders inverse verb)
export const TicketLinkDirection = z.enum(["outgoing", "incoming"]);
export type TicketLinkDirection = z.infer<typeof TicketLinkDirection>;

// Compact "the other ticket" reference embedded in link responses so
// the UI doesn't need a second fetch per row.
export const TicketLinkOther = z.object({
  id: Uuid,
  key: TicketKey,
  title: z.string(),
});
export type TicketLinkOther = z.infer<typeof TicketLinkOther>;

export const TicketLink = z.object({
  id: Uuid,
  type: TicketLinkType,
  direction: TicketLinkDirection,
  other_ticket: TicketLinkOther,
  created_at: Iso8601,
  created_by: UserRef,
});
export type TicketLink = z.infer<typeof TicketLink>;

// POST body. `target` accepts either a ticket UUID or a KEY-NUMBER
// (matching the lookup pattern used elsewhere in the API).
export const CreateTicketLink = z.object({
  type: TicketLinkType,
  target: z.string().min(1).max(50),
});
export type CreateTicketLink = z.infer<typeof CreateTicketLink>;
