import { describe, expect, test } from "bun:test";
import { encodeCursor, decodeCursor, buildPage } from "../../src/lib/pagination.js";

describe("cursor codec", () => {
  test("roundtrip", () => {
    const c = { u: "2026-05-02T15:04:05.000Z", i: "abc-123" };
    expect(decodeCursor(encodeCursor(c))).toEqual(c);
  });

  test("rejects malformed input", () => {
    expect(decodeCursor("not-base64-at-all-{}")).toBeNull();
    expect(decodeCursor(Buffer.from("{}", "utf8").toString("base64url"))).toBeNull();
    expect(decodeCursor(Buffer.from('{"u":"x"}', "utf8").toString("base64url"))).toBeNull();
  });

  test("encoded form is url-safe (no + / =)", () => {
    const enc = encodeCursor({ u: "x".repeat(40), i: "y".repeat(40) });
    expect(enc).not.toMatch(/[+/=]/);
  });
});

describe("buildPage", () => {
  const rows = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      id: `id-${i}`,
      updated_at: `2026-05-02T15:04:0${i}.000Z`,
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
  });

  test("empty rows produce empty page", () => {
    const out = buildPage([], 50);
    expect(out.items).toEqual([]);
    expect(out.page.has_more).toBe(false);
    expect(out.page.next_cursor).toBeNull();
  });
});
