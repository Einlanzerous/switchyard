// Unit coverage for the Plan-as-PR pure logic (SWY-109): the review-verdict
// state-machine mapping and the render-time revision diff. No DB.
import { describe, expect, test } from "bun:test";

process.env.DATABASE_URL = process.env.DATABASE_URL_TEST!;
const { reviewOutcome, computePlanDiff } = await import("../../src/lib/plans.js");

describe("reviewOutcome — verdict → (revision, plan, event)", () => {
  test("approved → plan approved, emits plan.approved", () => {
    expect(reviewOutcome("approved")).toEqual({
      revisionStatus: "approved",
      planStatus: "approved",
      eventType: "plan.approved",
    });
  });

  test("changes_requested → rework, emits plan.changes_requested", () => {
    expect(reviewOutcome("changes_requested")).toEqual({
      revisionStatus: "changes_requested",
      planStatus: "changes_requested",
      eventType: "plan.changes_requested",
    });
  });

  test("rejected → rework plan state BUT distinct plan.rejected event (the locked decision)", () => {
    // The plan returns to changes_requested (a rework state, no terminal
    // 'rejected' plan status) while emitting the DISTINCT plan.rejected event so
    // 7.2 rules can route 'wrong approach' differently from a nit-fix loop.
    expect(reviewOutcome("rejected")).toEqual({
      revisionStatus: "rejected",
      planStatus: "changes_requested",
      eventType: "plan.rejected",
    });
  });
});

describe("computePlanDiff", () => {
  test("revision 1 (no predecessor) → all-added, from_rev_number null", () => {
    const d = computePlanDiff(null, { narrative_md: "line a\nline b", criteria: ["x", "y"] });
    expect(d.from_rev_number).toBeNull();
    expect(d.narrative).toEqual([
      { type: "added", text: "line a" },
      { type: "added", text: "line b" },
    ]);
    expect(d.criteria).toEqual([
      { type: "added", position: 0, text: "x" },
      { type: "added", position: 1, text: "y" },
    ]);
  });

  test("narrative diff classifies context / added / removed lines", () => {
    const d = computePlanDiff(
      { rev_number: 1, narrative_md: "keep\nold", criteria: [] },
      { narrative_md: "keep\nnew", criteria: [] },
    );
    expect(d.from_rev_number).toBe(1);
    const lines = d.narrative.map((l) => `${l.type}:${l.text}`);
    expect(lines).toContain("context:keep");
    expect(lines).toContain("removed:old");
    expect(lines).toContain("added:new");
  });

  test("criteria diff: added / removed / unchanged via LCS", () => {
    const d = computePlanDiff(
      { rev_number: 2, narrative_md: "", criteria: ["a", "b", "c"] },
      { narrative_md: "", criteria: ["a", "c", "d"] },
    );
    const texts = (t: string) => d.criteria.filter((c) => c.type === t).map((c) => c.text).sort();
    expect(texts("unchanged")).toEqual(["a", "c"]);
    expect(texts("removed")).toEqual(["b"]);
    expect(texts("added")).toEqual(["d"]);
  });

  test("identical revisions → all context / unchanged", () => {
    const d = computePlanDiff(
      { rev_number: 3, narrative_md: "same\ntext", criteria: ["one", "two"] },
      { narrative_md: "same\ntext", criteria: ["one", "two"] },
    );
    expect(d.narrative.every((l) => l.type === "context")).toBe(true);
    expect(d.criteria.every((c) => c.type === "unchanged")).toBe(true);
  });
});
