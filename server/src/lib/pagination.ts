// Cursor pagination for list endpoints.
//
// Cursors are opaque base64-encoded JSON: { "k": "<sort_value>", "i": "<id>" }.
// `k` is the value of the chosen sort column (string for timestamps, integer
// string for enum ordinals, or `null` when sorting by a nullable column and
// the cursor row's value is NULL). Clients pass next_cursor straight back into
// the next request — they never look inside.
//
// Default ordering is `(updated_at DESC, id DESC)`. The tickets list endpoint
// supports an alternative sort column (see TicketSortBy in the shared
// schemas); other endpoints stay on the simple variant.
//
// Backward-compat: older cursors in the wild were shape `{ "u", "i" }`. We
// decode those into `{ k: u, i }` so in-flight pagination tokens from prior
// releases keep working.

import { and, asc, desc, lt, gt, or, eq, isNull, isNotNull, sql, type SQL, type Column, type SQLWrapper } from "drizzle-orm";

export type Cursor = { k: string | null; i: string };

export function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
}

export function decodeCursor(s: string): Cursor | null {
  try {
    const json = Buffer.from(s, "base64url").toString("utf8");
    const parsed = JSON.parse(json) as { k?: unknown; i?: unknown; u?: unknown };
    if (typeof parsed?.i !== "string") return null;
    // Legacy shape: { u, i } → { k: u, i }
    if (typeof parsed.k === "string" || parsed.k === null) {
      return { k: parsed.k, i: parsed.i };
    }
    if (typeof parsed.u === "string") {
      return { k: parsed.u, i: parsed.i };
    }
    return null;
  } catch {
    return null;
  }
}

// Build the cursor-WHERE expression for the default `(updated_at DESC, id DESC)`
// ordering: rows with updated_at strictly older than the cursor's, OR same
// updated_at and a smaller id.
export function cursorWhere(
  updatedAtCol: Column,
  idCol: Column,
  cursor: Cursor
): SQL {
  // Legacy callers always sort DESC on a non-null column. Treat a null cursor
  // value as "no value seen yet" — i.e. start from the most recent row.
  if (cursor.k === null) {
    return lt(idCol, cursor.i)!;
  }
  return or(
    lt(updatedAtCol, cursor.k),
    and(eq(updatedAtCol, cursor.k), lt(idCol, cursor.i))!
  )!;
}

export const cursorOrderBy = (updatedAtCol: Column, idCol: Column) =>
  [desc(updatedAtCol), desc(idCol)] as const;

// Build the page envelope: items truncated to `limit`, next_cursor populated
// only when more results may exist. The `keyOf` accessor controls which row
// field becomes the cursor's `k`. Defaults to `updated_at` for the legacy
// callers that don't pass one.
export function buildPage<T extends { id: string; updated_at: string }>(
  rows: T[],
  limit: number,
  keyOf: (row: T) => string | null = (r) => r.updated_at
): { items: T[]; page: { next_cursor: string | null; has_more: boolean } } {
  const has_more = rows.length > limit;
  const items = has_more ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];
  const next_cursor =
    has_more && last ? encodeCursor({ k: keyOf(last), i: last.id }) : null;
  return { items, page: { next_cursor, has_more } };
}

// ─── sorted variant ────────────────────────────────────────────────────────
//
// For endpoints that need a configurable sort column (currently just
// /v1/tickets). The key column may be nullable; nulls always sort last
// regardless of direction so "next due" semantics survive a flip to DESC.

export type SortDir = "asc" | "desc";

export type SortKey = {
  // The column or expression to ORDER BY. Drizzle accepts both `Column`
  // values and raw SQL expressions (e.g. a CASE statement for enum
  // ordinals).
  col: Column | SQLWrapper;
  dir: SortDir;
  // True when the sort column may be NULL. NULLS LAST is enforced.
  nullable: boolean;
};

// Cursor WHERE for an arbitrary sort key + id tiebreaker. Mirrors the
// `(key dir nulls-last, id DESC)` ordering used by sortedOrderBy below.
//
// When the sort column is NOT nullable, the predicate is straightforward:
// strict inequality on the key OR equal-key-and-smaller-id.
//
// When the sort column IS nullable, the predicate splits into three regions
// because nulls always sort to the bottom regardless of dir:
//   - cursor in the "values" region (k !== null) → next page can be either
//     a "later" non-null value or any null row,
//   - cursor in the "nulls" region (k === null) → only a smaller id in the
//     null tail is a valid next-page row.
export function cursorWhereSorted(
  key: SortKey,
  idCol: Column,
  cursor: Cursor
): SQL {
  const valueCmp = key.dir === "asc" ? gt : lt;

  if (!key.nullable) {
    // k must be non-null when the column itself is non-null. Treat a stray
    // null as "start from the very beginning" — equivalent to no cursor.
    if (cursor.k === null) return lt(idCol, cursor.i)!;
    return or(
      valueCmp(key.col as Column, cursor.k),
      and(eq(key.col as Column, cursor.k), lt(idCol, cursor.i))!
    )!;
  }

  if (cursor.k === null) {
    // Already in the nulls tail. Only smaller-id rows within the tail remain.
    return and(isNull(key.col as Column), lt(idCol, cursor.i))!;
  }

  // Still in the values region. Either move to a "later" non-null value, hit
  // the equal-value-id tiebreaker, or fall into the nulls tail.
  return or(
    and(isNotNull(key.col as Column), valueCmp(key.col as Column, cursor.k))!,
    and(isNotNull(key.col as Column), eq(key.col as Column, cursor.k), lt(idCol, cursor.i))!,
    isNull(key.col as Column),
  )!;
}

export function sortedOrderBy(key: SortKey, idCol: Column) {
  const valueOrder = key.dir === "asc" ? asc(key.col as Column) : desc(key.col as Column);
  // NULLS LAST: emit a leading `(col IS NULL) ASC` so null rows fall to the
  // end regardless of direction. false (= has value) sorts before true
  // (= null), so we get nulls last for both asc and desc orderings.
  if (key.nullable) {
    const nullsLastTie = asc(sql`(${key.col} IS NULL)`);
    return [nullsLastTie, valueOrder, desc(idCol)] as const;
  }
  return [valueOrder, desc(idCol)] as const;
}
