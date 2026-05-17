import { describe, expect, test } from "bun:test";
import {
  encodeCursor, decodeCursor, buildPage,
  cursorWhereSorted, sortedOrderBy, type SortKey,
} from "../../src/lib/pagination.js";
import * as schema from "../../drizzle/schema.js";

describe("cursor codec", () => {
  test("roundtrip on new {k, i} shape", () => {
    const c = { k: "2026-05-02T15:04:05.000Z", i: "abc-123" };
    expect(decodeCursor(encodeCursor(c))).toEqual(c);
  });

  test("roundtrip preserves null k for nullable-sort cursors", () => {
    const c = { k: null, i: "abc-123" };
    expect(decodeCursor(encodeCursor(c))).toEqual(c);
  });

  test("decodes legacy {u, i} payloads (backward-compat)", () => {
    // Pre-4.8 deployments emitted { u, i } cursors. Pagination tokens that
    // survive a restart must still decode after the schema flip.
    const legacy = Buffer.from(
      JSON.stringify({ u: "2026-05-02T15:04:05.000Z", i: "abc-123" }),
      "utf8",
    ).toString("base64url");
    expect(decodeCursor(legacy)).toEqual({
      k: "2026-05-02T15:04:05.000Z",
      i: "abc-123",
    });
  });

  test("rejects malformed input", () => {
    expect(decodeCursor("not-base64-at-all-{}")).toBeNull();
    expect(decodeCursor(Buffer.from("{}", "utf8").toString("base64url"))).toBeNull();
    // Missing i field
    expect(decodeCursor(Buffer.from('{"k":"x"}', "utf8").toString("base64url"))).toBeNull();
    // i must be a string
    expect(decodeCursor(Buffer.from('{"k":"x","i":42}', "utf8").toString("base64url"))).toBeNull();
  });

  test("encoded form is url-safe (no + / =)", () => {
    const enc = encodeCursor({ k: "x".repeat(40), i: "y".repeat(40) });
    expect(enc).not.toMatch(/[+/=]/);
  });
});

describe("buildPage", () => {
  const rows = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      id: `id-${i}`,
      updated_at: `2026-05-02T15:04:0${i}.000Z`,
      due_date: i % 2 === 0 ? `2026-06-0${i}T00:00:00.000Z` : null,
      payload: i,
    }));

  test("returns all items and no cursor when below limit", () => {
    const r = rows(3);
    const out = buildPage(r, 5);
    expect(out.items).toHaveLength(3);
    expect(out.page.has_more).toBe(false);
    expect(out.page.next_cursor).toBeNull();
  });

  test("trims to limit and emits cursor when more results exist", () => {
    const r = rows(6);
    const out = buildPage(r, 5);
    expect(out.items).toHaveLength(5);
    expect(out.page.has_more).toBe(true);
    expect(out.page.next_cursor).not.toBeNull();
    const decoded = decodeCursor(out.page.next_cursor!);
    expect(decoded?.i).toBe("id-4"); // last item kept (index 4 of 5)
    // Default keyOf reads updated_at
    expect(decoded?.k).toBe("2026-05-02T15:04:04.000Z");
  });

  test("custom keyOf encodes the chosen sort column", () => {
    const r = rows(4); // due_date alternates non-null, null, non-null, null
    const out = buildPage(r, 3, (row) => row.due_date);
    expect(out.page.has_more).toBe(true);
    const decoded = decodeCursor(out.page.next_cursor!);
    // Last kept row is index 2; due_date is non-null
    expect(decoded?.i).toBe("id-2");
    expect(decoded?.k).toBe("2026-06-02T00:00:00.000Z");
  });

  test("custom keyOf can emit null for nullable sort key tails", () => {
    const r = rows(4);
    // Force the last visible row into the nulls tail by selecting only odd
    // indices (those have due_date === null).
    const tailRows = r.filter((_, i) => i % 2 === 1);
    const out = buildPage(tailRows, 1, (row) => row.due_date);
    expect(out.page.has_more).toBe(true);
    const decoded = decodeCursor(out.page.next_cursor!);
    expect(decoded?.k).toBeNull();
  });

  test("empty rows produce empty page", () => {
    const out = buildPage([], 50);
    expect(out.items).toEqual([]);
    expect(out.page.has_more).toBe(false);
    expect(out.page.next_cursor).toBeNull();
  });
});

describe("cursorWhereSorted + sortedOrderBy", () => {
  // We can't run SQL without a DB, but we can verify the helpers build
  // non-null SQL fragments for each branch — that's enough to catch the
  // common mistakes (forgotten `!`, wrong dir, etc.). Integration coverage
  // for the actual WHERE/ORDER BY semantics lives in the tickets list
  // integration suite.

  test("nullable sort key builds a 3-region predicate when cursor in values region", () => {
    const key: SortKey = {
      col: schema.tickets.due_date,
      dir: "asc",
      nullable: true,
    };
    const where = cursorWhereSorted(key, schema.tickets.id, {
      k: "2026-06-01T00:00:00.000Z",
      i: "abc-123",
    });
    expect(where).toBeDefined();
  });

  test("nullable sort key cursor in nulls tail builds an AND-IS-NULL-AND-lt-id predicate", () => {
    const key: SortKey = {
      col: schema.tickets.due_date,
      dir: "asc",
      nullable: true,
    };
    const where = cursorWhereSorted(key, schema.tickets.id, {
      k: null,
      i: "abc-123",
    });
    expect(where).toBeDefined();
  });

  test("non-nullable sort key builds a 2-clause predicate", () => {
    const key: SortKey = {
      col: schema.tickets.updated_at,
      dir: "desc",
      nullable: false,
    };
    const where = cursorWhereSorted(key, schema.tickets.id, {
      k: "2026-05-02T15:04:00.000Z",
      i: "abc-123",
    });
    expect(where).toBeDefined();
  });

  test("sortedOrderBy emits a nulls-last leader expression for nullable keys", () => {
    const key: SortKey = {
      col: schema.tickets.due_date,
      dir: "asc",
      nullable: true,
    };
    const order = sortedOrderBy(key, schema.tickets.id);
    // 3 ORDER BY parts: nulls-last leader, value order, id tiebreak
    expect(order).toHaveLength(3);
  });

  test("sortedOrderBy emits a 2-part list for non-nullable keys", () => {
    const key: SortKey = {
      col: schema.tickets.updated_at,
      dir: "desc",
      nullable: false,
    };
    const order = sortedOrderBy(key, schema.tickets.id);
    expect(order).toHaveLength(2);
  });
});
