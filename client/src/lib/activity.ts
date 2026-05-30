// Activity-feed presentation helpers.
//
// A status transition into a terminal category writes MORE THAN ONE event row:
// `ticket.status_changed` always, plus `ticket.closed` (entering a closed
// category) and/or `ticket.released` (resolution = released). That fan-out is
// intentional on the server — each row is a distinct, separately-subscribable
// webhook/rule trigger — but in a human-facing feed it double-renders as e.g.
// "moved" + "closed" for one action.
//
// `collapseTransitionEvents` drops the generic `ticket.status_changed` row when
// a terminal twin (`ticket.closed`/`ticket.released`) exists for the same ticket
// and identical status change. `closed` and `released` are always kept and are
// never collapsed into each other — a release is a valid distinct notification.
// The event log itself (`/v1/events`), webhooks, and rule firings are untouched;
// this is purely a display concern.

const TERMINAL_EVENTS = new Set(["ticket.closed", "ticket.released"]);

// Minimal structural shape this helper needs. Kept generic so callers can pass
// either the shared `Event` type or the openapi-generated event row without a
// cast, and get the same element type back.
type FeedEvent = {
  event: string;
  ticket?: { id: string } | null;
  changes?: { status?: unknown } | null;
};

// Identifies a single transition: same ticket + same status change (from/to/
// resolution). Both the `status_changed` row and its terminal twin carry an
// identical `changes.status` payload, so they serialize to the same key.
function transitionKey(e: FeedEvent): string | null {
  if (!e.ticket || !e.changes?.status) return null;
  return `${e.ticket.id}|${JSON.stringify(e.changes.status)}`;
}

export function collapseTransitionEvents<T extends FeedEvent>(events: T[]): T[] {
  const terminalKeys = new Set<string>();
  for (const e of events) {
    if (!TERMINAL_EVENTS.has(e.event)) continue;
    const key = transitionKey(e);
    if (key) terminalKeys.add(key);
  }
  if (terminalKeys.size === 0) return events;

  return events.filter((e) => {
    if (e.event !== "ticket.status_changed") return true;
    const key = transitionKey(e);
    return key === null || !terminalKeys.has(key);
  });
}
