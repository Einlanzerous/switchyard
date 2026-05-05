// Cursor pagination for list endpoints.
//
// Cursors are opaque base64-encoded JSON: { "u": "<updated_at>", "i": "<id>" }.
// The server never exposes the format to clients; clients pass the next_cursor
// from one response straight back into the `cursor=` query param of the next.
//
// Ordering is `(updated_at DESC, id DESC)` everywhere. Stable within a single
// updated_at value via the id tiebreaker; does not require updated_at to be
// monotonic across rows (which it isn't — multi-row updates can collide).

import { and, desc, lt, or, eq, type SQL, type Column } from "drizzle-orm";

export type Cursor = { u: string; i: string };

export function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
}

export function decodeCursor(s: string): Cursor | null {
  try {
    const json = Buffer.from(s, "base64url").toString("utf8");
    const parsed = JSON.parse(json) as Cursor;
    if (typeof parsed?.u !== "string" || typeof parsed?.i !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

// Build the cursor-WHERE expression: rows with updated_at strictly older than
// the cursor's, OR same updated_at and a smaller id.
export function cursorWhere(
  updatedAtCol: Column,
  idCol: Column,
  cursor: Cursor
): SQL {
  return or(
    lt(updatedAtCol, cursor.u),
    and(eq(updatedAtCol, cursor.u), lt(idCol, cursor.i))!
  )!;
}

export const cursorOrderBy = (updatedAtCol: Column, idCol: Column) =>
  [desc(updatedAtCol), desc(idCol)] as const;

// Build the page envelope: items truncated to `limit`, next_cursor populated
// only when more results may exist.
export function buildPage<T extends { id: string; updated_at: string }>(
  rows: T[],
  limit: number
): { items: T[]; page: { next_cursor: string | null; has_more: boolean } } {
  const has_more = rows.length > limit;
  const items = has_more ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];
  const next_cursor = has_more && last ? encodeCursor({ u: last.updated_at, i: last.id }) : null;
  return { items, page: { next_cursor, has_more } };
}

// Convenience: apply pagination to a builder. Caller is responsible for
// composing this with their own WHERE clauses (project filter, search, etc.).
//
// Usage:
//   const limit = q.limit ?? 50;
//   const where = q.cursor
//     ? and(filters, cursorWhere(table.updated_at, table.id, decodeCursor(q.cursor)!))
//     : filters;
//   const rows = await db.select().from(table).where(where)
//     .orderBy(...cursorOrderBy(table.updated_at, table.id))
//     .limit(limit + 1);
//   return buildPage(rows, limit);
//
// We don't wrap the whole query because Drizzle's typed builders don't
// generalize cleanly across different selects (joins, projections, etc.).
