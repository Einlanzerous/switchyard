// writeEvent — the single chokepoint for emitting events.
//
// One call writes:
//   1. an `events` row (audit log + chart source)
//   2. zero or more `webhook_deliveries` rows for matching subscriptions
// …all inside the caller's transaction. If the caller's transaction rolls back,
// neither the event nor the deliveries are persisted — no orphaned webhooks.

import { eq, and } from "drizzle-orm";
import * as schema from "../../drizzle/schema.js";
import type { db as defaultDb } from "../db.js";
import type {
  EventType, UserRef, TicketSummary, EventChanges, StatusChange,
} from "@switchyard/shared";

// Drizzle's transaction type is awkward to import; this is the structurally
// minimal subset we use. Pass either `db` or a `tx` from `db.transaction(async tx => {...})`.
type Tx = typeof defaultDb;

export type WriteEventInput = {
  event_type: EventType;
  actor: UserRef | null;
  ticket?: TicketSummary | null;
  project_id?: string | null;
  changes?: EventChanges;
  // Event-specific extras merged into the persisted payload (e.g. comment body).
  extras?: Record<string, unknown>;
};

export async function writeEvent(tx: Tx, input: WriteEventInput): Promise<{ id: string; created_at: string }> {
  const ticketId = input.ticket?.id ?? null;
  const projectId = input.project_id ?? input.ticket?.project?.id ?? null;
  const actorId = input.actor?.id ?? null;

  // Snapshot the full webhook-shaped payload here so the dispatcher just sends
  // it unchanged. If the ticket/actor mutate later, the webhook still reflects
  // the state at event time.
  const payload = {
    actor: input.actor,
    ticket: input.ticket ?? null,
    changes: input.changes ?? null,
    ...input.extras,
  };

  const [eventRow] = await tx
    .insert(schema.events)
    .values({
      event_type: input.event_type,
      ticket_id: ticketId,
      project_id: projectId,
      actor_id: actorId,
      payload,
    })
    .returning({ id: schema.events.id, created_at: schema.events.created_at });

  if (!eventRow) throw new Error("failed to insert event row");

  // Find matching subscriptions (active + event_type matches). Status filter
  // is applied in JS because it's a JSONB partial-match against the changes
  // payload; doing it in SQL would require flattening the filter shape.
  const subs = await tx
    .select()
    .from(schema.webhookSubscriptions)
    .where(eq(schema.webhookSubscriptions.active, true));

  const matches = subs.filter((s) => matchesSubscription(s, input.event_type, input.changes?.status));

  if (matches.length > 0) {
    const nowIso = new Date().toISOString();
    await tx.insert(schema.webhookDeliveries).values(
      matches.map((s) => ({
        subscription_id: s.id,
        event_id: eventRow.id,
        status: "pending" as const,
        next_attempt_at: nowIso,
      }))
    );
  }

  return eventRow;
}

function matchesSubscription(
  sub: typeof schema.webhookSubscriptions.$inferSelect,
  eventType: string,
  statusChange: StatusChange | undefined
): boolean {
  const types = sub.event_types as string[];
  const typeOk = types.includes("*") || types.includes(eventType);
  if (!typeOk) return false;

  const filter = sub.status_filter as
    | { to_category?: string; from_category?: string; to_status_display_name?: string }
    | null;
  if (!filter) return true;

  if (filter.to_category && statusChange?.to?.category !== filter.to_category) return false;
  if (filter.from_category && statusChange?.from?.category !== filter.from_category) return false;
  if (
    filter.to_status_display_name &&
    statusChange?.to?.display_name !== filter.to_status_display_name
  ) {
    return false;
  }
  return true;
}
