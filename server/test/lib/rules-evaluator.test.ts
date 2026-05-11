// Unit tests for the rule condition DSL evaluator. No DB; just function calls.

import { describe, expect, test } from "bun:test";
import { evaluate, resolveFieldPath, evalLeaf } from "../../src/lib/rules/evaluator.js";

const samplePayload = {
  actor: { id: "u1", name: "magos", type: "human" },
  ticket: {
    id: "t1",
    key: "SWY-1",
    title: "the test ticket",
    priority: "high",
    type: "bug",
    status: { category: "in_progress", display_name: "In Progress" },
    labels: [
      { id: "l1", name: "frontend", color: "#abc123" },
      { id: "l2", name: "regression", color: "#def456" },
    ],
    assignee: null,
  },
  changes: {
    status: {
      from: { category: "backlog", display_name: "Backlog" },
      to: { category: "in_progress", display_name: "In Progress" },
    },
  },
};

describe("resolveFieldPath", () => {
  test("simple nested path", () => {
    expect(resolveFieldPath(samplePayload, "ticket.priority")).toBe("high");
    expect(resolveFieldPath(samplePayload, "actor.name")).toBe("magos");
  });

  test("missing intermediate segments yield undefined", () => {
    expect(resolveFieldPath(samplePayload, "ticket.missing.nested")).toBeUndefined();
    expect(resolveFieldPath(samplePayload, "nonexistent")).toBeUndefined();
  });

  test("[] projection across array", () => {
    const names = resolveFieldPath(samplePayload, "ticket.labels[].name");
    expect(names).toEqual(["frontend", "regression"]);
  });

  test("[] on missing array yields undefined", () => {
    expect(resolveFieldPath(samplePayload, "ticket.nope[].name")).toBeUndefined();
  });
});

describe("ops on leaves", () => {
  const leaf = (field: string, op: string, value?: unknown) =>
    evalLeaf(samplePayload, { field, op: op as any, value });

  test("eq: matches single value", () => {
    expect(leaf("ticket.priority", "eq", "high").matched).toBe(true);
    expect(leaf("ticket.priority", "eq", "low").matched).toBe(false);
  });

  test("eq: matches any element in projected array", () => {
    expect(leaf("ticket.labels[].name", "eq", "frontend").matched).toBe(true);
    expect(leaf("ticket.labels[].name", "eq", "missing").matched).toBe(false);
  });

  test("ne: inverse of eq, all elements must differ", () => {
    expect(leaf("ticket.priority", "ne", "low").matched).toBe(true);
    expect(leaf("ticket.priority", "ne", "high").matched).toBe(false);
    // For array projection, ne must hold for ALL elements
    expect(leaf("ticket.labels[].name", "ne", "frontend").matched).toBe(false);
    expect(leaf("ticket.labels[].name", "ne", "missing").matched).toBe(true);
  });

  test("in: any value matches the list", () => {
    expect(leaf("ticket.priority", "in", ["medium", "high"]).matched).toBe(true);
    expect(leaf("ticket.priority", "in", ["low"]).matched).toBe(false);
    expect(leaf("ticket.priority", "in", "not-an-array").matched).toBe(false);
  });

  test("not_in: no value in the list", () => {
    expect(leaf("ticket.priority", "not_in", ["low", "medium"]).matched).toBe(true);
    expect(leaf("ticket.priority", "not_in", ["high"]).matched).toBe(false);
  });

  test("contains: case-insensitive substring on strings", () => {
    expect(leaf("ticket.title", "contains", "TEST").matched).toBe(true);
    expect(leaf("ticket.title", "contains", "nope").matched).toBe(false);
  });

  test("contains: element-equality on arrays", () => {
    expect(leaf("ticket.labels[].name", "contains", "regression").matched).toBe(true);
    expect(leaf("ticket.labels[].name", "contains", "regress").matched).toBe(true); // substring
  });

  test("is_null: field absent or null", () => {
    expect(leaf("ticket.assignee", "is_null").matched).toBe(true);
    expect(leaf("ticket.missing", "is_null").matched).toBe(true);
    expect(leaf("ticket.priority", "is_null").matched).toBe(false);
  });

  test("is_not_null: field present and non-null", () => {
    expect(leaf("ticket.priority", "is_not_null").matched).toBe(true);
    expect(leaf("ticket.assignee", "is_not_null").matched).toBe(false);
  });

  test("changes.status.to.category resolves", () => {
    expect(leaf("changes.status.to.category", "eq", "in_progress").matched).toBe(true);
    expect(leaf("changes.status.to.category", "eq", "closed").matched).toBe(false);
  });
});

describe("groups", () => {
  test("empty conditions = always true", () => {
    expect(evaluate(samplePayload, {}).matched).toBe(true);
  });

  test("all: every leaf must match (short-circuits)", () => {
    const cond = {
      all: [
        { field: "ticket.priority", op: "eq" as const, value: "high" },
        { field: "ticket.type", op: "eq" as const, value: "bug" },
      ],
    };
    expect(evaluate(samplePayload, cond).matched).toBe(true);

    const cond2 = {
      all: [
        { field: "ticket.priority", op: "eq" as const, value: "high" },
        { field: "ticket.type", op: "eq" as const, value: "task" },
      ],
    };
    expect(evaluate(samplePayload, cond2).matched).toBe(false);
  });

  test("any: at least one leaf must match", () => {
    const cond = {
      any: [
        { field: "ticket.priority", op: "eq" as const, value: "low" },
        { field: "ticket.type", op: "eq" as const, value: "bug" },
      ],
    };
    expect(evaluate(samplePayload, cond).matched).toBe(true);

    const cond2 = {
      any: [
        { field: "ticket.priority", op: "eq" as const, value: "low" },
        { field: "ticket.type", op: "eq" as const, value: "task" },
      ],
    };
    expect(evaluate(samplePayload, cond2).matched).toBe(false);
  });

  test("nested: top all with inner any", () => {
    const cond = {
      all: [
        { field: "ticket.priority", op: "eq" as const, value: "high" },
        {
          any: [
            { field: "ticket.type", op: "eq" as const, value: "task" },
            { field: "ticket.labels[].name", op: "contains" as const, value: "regression" },
          ],
        },
      ],
    };
    expect(evaluate(samplePayload, cond).matched).toBe(true);

    const cond2 = {
      all: [
        { field: "ticket.priority", op: "eq" as const, value: "high" },
        {
          any: [
            { field: "ticket.type", op: "eq" as const, value: "task" },
            { field: "ticket.labels[].name", op: "contains" as const, value: "missing" },
          ],
        },
      ],
    };
    expect(evaluate(samplePayload, cond2).matched).toBe(false);
  });
});
