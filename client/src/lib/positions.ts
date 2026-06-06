// Fractional indexing + sort modes for ticket order within a column.
//
// Each ticket carries a `position` number. Higher = closer to the top. When
// the user drops a card between two others, we compute a new position halfway
// between the neighbors so existing rows don't have to shuffle. For tickets
// without a position (legacy rows pre-backfill), we fall back to their
// updated_at timestamp interpreted as ms-since-epoch — same scale the new
// epoch-ms-on-create scheme uses, so all values live on a comparable axis.
//
// Sort modes layer on top of position. The board defaults to "smart" — due
// date floats dated tickets to the top, undated tickets keep their position
// order. Drag-reorder always updates `position`, so a manual drag inside a
// sort mode is still a meaningful nudge (it just only re-orders within the
// same due-date bucket, which is the right semantics).

import type { TicketSummary } from "@switchyard/shared";

const STEP = 1024;

function effectivePosition(t: TicketSummary): number {
  if (typeof t.position === "number") return t.position;
  // Backfilled at server boot, but a defensive fallback if the migrate step
  // hasn't run yet against an older container.
  return Date.parse(t.updated_at);
}

// Compute a position that lands the new card between `before` (the card
// rendered just above the drop target, i.e. higher in the column with a
// higher position) and `after` (the card just below, lower position). Either
// can be null to indicate the very top or very bottom of the column.
export function positionBetween(
  before: TicketSummary | null,
  after: TicketSummary | null
): number {
  const b = before ? effectivePosition(before) : null;
  const a = after ? effectivePosition(after) : null;

  if (b === null && a === null) return Date.now();
  if (b === null && a !== null) return a + STEP; // new top of column
  if (a === null && b !== null) return b - STEP; // new bottom of column
  // Midpoint between the two neighbors. Float precision starts dropping after
  // ~50 binary halvings; for a homelab kanban that's fine.
  return ((b as number) + (a as number)) / 2;
}

// ─── sort modes ────────────────────────────────────────────────────────────

export type SortMode =
  // Default: manual position order (drag-driven). Newly-created tickets get
  // epoch-ms-at-create positions and stack newest-first; drag-to-reorder
  // overwrites via fractional indexing. Alias of `position` — kept as a
  // distinct value so a future "smart placement at create time" feature
  // can fill in the smart half without churning the URL contract.
  | "smart"
  // Explicit manual order (identical to smart today).
  | "position"
  // Strict due-date sort: due_date ASC NULLS LAST → position DESC → id DESC.
  | "due_date"
  | "updated"
  | "created"
  | "priority";

export const SORT_MODES: { value: SortMode; label: string }[] = [
  { value: "smart", label: "Manual order" },
  { value: "due_date", label: "Due date" },
  { value: "priority", label: "Priority" },
  { value: "updated", label: "Recently updated" },
  { value: "created", label: "Recently created" },
];

const PRIORITY_ORDINAL: Record<NonNullable<TicketSummary["priority"]>, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

function dueOrInfinity(t: TicketSummary): number {
  // Null due_date sorts last in ascending order — return +∞ so it lands after
  // any real date. Real dates compare numerically via Date.parse.
  if (!t.due_date) return Number.POSITIVE_INFINITY;
  const ms = Date.parse(t.due_date);
  return Number.isNaN(ms) ? Number.POSITIVE_INFINITY : ms;
}

function priorityOrdinal(t: TicketSummary): number {
  // Null priority sorts last in descending order — return -∞ so it lands at
  // the bottom regardless of direction.
  return t.priority ? PRIORITY_ORDINAL[t.priority] : Number.NEGATIVE_INFINITY;
}

// Returns negative if `a` should sort before `b`, positive if after, 0 if
// equivalent. Use as `arr.sort((a, b) => compareTickets(a, b, mode))`.
//
// Design note: `smart` and `position` are deliberately identical today —
// drag-driven manual order with no due-date primary. An earlier attempt
// had smart float dated tickets to the top, which made the comparator's
// primary key beat any drag-updated position (drag silently snapped back).
// The path forward for "dated tickets naturally rise to the top" is smart
// initial-position assignment at ticket-create time, not view-time sort;
// see PHASES.md follow-ups.
export function compareTickets(a: TicketSummary, b: TicketSummary, mode: SortMode): number {
  switch (mode) {
    case "smart":
    case "position":
      return effectivePosition(b) - effectivePosition(a);
    case "due_date": {
      const da = dueOrInfinity(a);
      const db = dueOrInfinity(b);
      if (da !== db) return da - db; // earlier dates first; null due dates fall to the bottom
      return effectivePosition(b) - effectivePosition(a);
    }
    case "priority": {
      const diff = priorityOrdinal(b) - priorityOrdinal(a); // critical first
      if (diff !== 0) return diff;
      return effectivePosition(b) - effectivePosition(a);
    }
    case "updated":
      return Date.parse(b.updated_at) - Date.parse(a.updated_at); // recent first
    case "created":
      // TicketSummary doesn't carry created_at directly; epoch-ms position is
      // the create-time stamp by default, so position is a good proxy when no
      // drag has happened. Fall back to position.
      return effectivePosition(b) - effectivePosition(a);
  }
}
