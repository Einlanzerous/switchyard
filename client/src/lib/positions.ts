// Fractional indexing for ticket order within a column.
//
// Each ticket carries a `position` number. Higher = closer to the top. When
// the user drops a card between two others, we compute a new position halfway
// between the neighbors so existing rows don't have to shuffle. For tickets
// without a position (legacy rows pre-backfill), we fall back to their
// updated_at timestamp interpreted as ms-since-epoch — same scale the new
// epoch-ms-on-create scheme uses, so all values live on a comparable axis.

import type { TicketSummary } from "@switchyard/shared";

export const STEP = 1024;

export function effectivePosition(t: TicketSummary): number {
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
