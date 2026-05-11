// Condition DSL evaluator. Operates on a webhook-shaped event payload
// (`actor`, `ticket`, `changes`, plus event-specific extras).
//
// Field paths: dot-separated. A segment ending in `[]` projects across an
// array — one level of projection is supported (e.g. `ticket.labels[].name`
// gives "any label's name"). Missing/undefined paths resolve to a single
// `undefined` value, which interacts predictably with each op.
//
// One-level nesting in the condition tree, enforced by the Zod schema in
// @switchyard/shared/rule: a top-level `all` may contain leaves and a single
// `any`-group, and vice versa.

import type {
  RuleConditions, RuleConditionLeaf, RuleConditionOp,
} from "@switchyard/shared";
import type { EvaluationOutcome } from "./types.js";

export function evaluate(
  payload: Record<string, unknown>,
  conditions: RuleConditions
): EvaluationOutcome {
  // Empty object = always-true rule (fires on event type alone).
  if (!conditions || Object.keys(conditions).length === 0) {
    return { matched: true };
  }

  const c = conditions as Record<string, unknown>;
  if (Array.isArray(c.all)) {
    return evalAll(payload, c.all as Group["items"]);
  }
  if (Array.isArray(c.any)) {
    return evalAny(payload, c.any as Group["items"]);
  }
  return { matched: false, reason: "malformed condition group" };
}

type Group = { items: Array<RuleConditionLeaf | { all?: RuleConditionLeaf[]; any?: RuleConditionLeaf[] }> };

function evalAll(payload: Record<string, unknown>, items: Group["items"]): EvaluationOutcome {
  for (const item of items) {
    const o = evalItem(payload, item);
    if (!o.matched) return o;
  }
  return { matched: true };
}

function evalAny(payload: Record<string, unknown>, items: Group["items"]): EvaluationOutcome {
  let lastReason: string | undefined;
  for (const item of items) {
    const o = evalItem(payload, item);
    if (o.matched) return { matched: true };
    lastReason = o.reason;
  }
  return { matched: false, reason: lastReason ?? "no `any` branch matched" };
}

function evalItem(payload: Record<string, unknown>, item: Group["items"][number]): EvaluationOutcome {
  // Nested inverse group.
  if ("all" in item && Array.isArray(item.all)) {
    return evalAll(payload, item.all as Group["items"]);
  }
  if ("any" in item && Array.isArray(item.any)) {
    return evalAny(payload, item.any as Group["items"]);
  }
  return evalLeaf(payload, item as RuleConditionLeaf);
}

export function evalLeaf(
  payload: Record<string, unknown>,
  leaf: RuleConditionLeaf
): EvaluationOutcome {
  const resolved = resolveFieldPath(payload, leaf.field);
  // resolved is either a single value or, for `[]` projection, an array of
  // values. We normalize to an array so each op can decide whether it cares.
  const values = Array.isArray(resolved) ? resolved : [resolved];
  const matched = applyOp(leaf.op, values, leaf.value);
  return matched
    ? { matched: true }
    : { matched: false, reason: `${leaf.field} ${leaf.op} ${formatValue(leaf.value)} → false` };
}

// ─── field path resolution ──────────────────────────────────────────────────
//
// `ticket.title` → look up payload.ticket.title.
// `ticket.labels[].name` → payload.ticket.labels is an array, project .name
//   across each → returns an array of strings.
// Missing segments yield `undefined` (preserved through projection to keep
// the "any matches" semantics consistent).

export function resolveFieldPath(payload: unknown, path: string): unknown {
  const segments = path.split(".");
  let current: unknown = payload;

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;

    if (seg.endsWith("[]")) {
      const key = seg.slice(0, -2);
      const arr = (current as Record<string, unknown> | null | undefined)?.[key];
      if (!Array.isArray(arr)) return undefined;

      const rest = segments.slice(i + 1).join(".");
      if (!rest) return arr;
      return arr.map((el) => resolveFieldPath(el, rest));
    }

    if (current === null || current === undefined) return undefined;
    if (typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[seg];
  }

  return current;
}

// ─── ops ────────────────────────────────────────────────────────────────────
//
// `values` is the resolved field value, normalized to an array. Each op
// decides its array semantics:
//   - eq/ne/in/not_in/contains: "any element matches" / "all elements differ"
//   - is_null / is_not_null: applies to the original value (array unwrapping
//     would obscure the semantic — `is_null` means "field absent", which
//     for an array projection means "the array itself is empty or absent").

function applyOp(op: RuleConditionOp, values: unknown[], expected: unknown): boolean {
  switch (op) {
    case "eq":
      return values.some((v) => deepEqual(v, expected));
    case "ne":
      return values.every((v) => !deepEqual(v, expected));
    case "in": {
      if (!Array.isArray(expected)) return false;
      return values.some((v) => expected.some((e) => deepEqual(v, e)));
    }
    case "not_in": {
      if (!Array.isArray(expected)) return true;
      return values.every((v) => !expected.some((e) => deepEqual(v, e)));
    }
    case "contains": {
      // String contains (case-insensitive) or array element-equality.
      const needle = expected;
      return values.some((v) => {
        if (typeof v === "string" && typeof needle === "string") {
          return v.toLowerCase().includes(needle.toLowerCase());
        }
        return deepEqual(v, needle);
      });
    }
    case "is_null":
      // "Field is absent". For a projected array, that means there were no
      // elements at all OR every element is null/undefined.
      return values.every((v) => v === undefined || v === null);
    case "is_not_null":
      return values.some((v) => v !== undefined && v !== null);
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;
  if (typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== (b as unknown[]).length) return false;
    return a.every((x, i) => deepEqual(x, (b as unknown[])[i]));
  }
  const ka = Object.keys(a as Record<string, unknown>);
  const kb = Object.keys(b as Record<string, unknown>);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

function formatValue(v: unknown): string {
  if (v === undefined) return "<undefined>";
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
