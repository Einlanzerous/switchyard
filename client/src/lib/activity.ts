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
// a terminal twin (`ticket.closed`/`ticket.released`) belongs to the same
// transition. `closed` and `released` are always kept and are never collapsed
// into each other — a release is a valid distinct notification. The event log
// itself (`/v1/events`), webhooks, and rule firings are untouched; this is
// purely a display concern.
//
// Two writers produce the pair, and they don't carry identical payloads:
//   - the transition route (routes/tickets.ts) attaches the same
//     `changes.status` to BOTH the status_changed and the closed/released rows;
//   - the rules engine (lib/rules/actions.ts) attaches `changes.status` to the
//     status_changed row but writes the closed/released rows with NO `changes`.
// So we can't rely on a shared status payload alone. What every path shares is
// the transaction: all rows of one transition are inserted in a single
// `db.transaction`, so they get an identical `occurred_at` (Postgres
// transaction_timestamp). We therefore match a status_changed to its terminal
// twin by EITHER an identical status payload OR same ticket + same
// `occurred_at`. This collapses every close path — and historical rows — with
// no migration.

const TERMINAL_EVENTS = new Set(["ticket.closed", "ticket.released"]);

// Minimal structural shape this helper needs. Kept generic so callers can pass
// either the shared `Event` type or the openapi-generated event row without a
// cast, and get the same element type back.
type FeedEvent = {
  event: string;
  occurred_at?: string | null;
  ticket?: { id: string } | null;
  changes?: { status?: unknown } | null;
};

// Status-payload key: present only when the row carries `changes.status` (the
// route handler attaches it to both rows; the rules engine only to the
// status_changed row). Used as a fallback signal independent of timestamps.
function statusKey(e: FeedEvent): string | null {
  if (!e.ticket || !e.changes?.status) return null;
  return `s|${e.ticket.id}|${JSON.stringify(e.changes.status)}`;
}

// Transaction key: same ticket + same `occurred_at`. Every row of one
// transition shares this (single transaction → one transaction_timestamp), and
// distinct transitions never do, so it's a safe join across all writers.
function timeKey(e: FeedEvent): string | null {
  if (!e.ticket || !e.occurred_at) return null;
  return `t|${e.ticket.id}|${e.occurred_at}`;
}

export function collapseTransitionEvents<T extends FeedEvent>(events: T[]): T[] {
  const terminalKeys = new Set<string>();
  for (const e of events) {
    if (!TERMINAL_EVENTS.has(e.event)) continue;
    for (const key of [statusKey(e), timeKey(e)]) {
      if (key) terminalKeys.add(key);
    }
  }
  if (terminalKeys.size === 0) return events;

  return events.filter((e) => {
    if (e.event !== "ticket.status_changed") return true;
    const sk = statusKey(e);
    const tk = timeKey(e);
    const hasTwin = (sk !== null && terminalKeys.has(sk)) || (tk !== null && terminalKeys.has(tk));
    return !hasTwin;
  });
}
