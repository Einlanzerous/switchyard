// Shared internal types for the rules engine. The Zod schemas in
// @switchyard/shared/rule are the source of truth at the API boundary; these
// are the runtime shapes the dispatcher/evaluator/actions hand each other.

import type {
  RuleAction, RuleConditions, RuleFiringResultSummary, RuleFiringActionResult,
  UserRef,
} from "@switchyard/shared";

// What the evaluator + action runner receive — a webhook-shaped envelope
// pulled from the `events.payload` JSONB column, augmented with rule + event
// metadata.
export type RuleContext = {
  event_id: string;
  event_type: string;
  event_payload: Record<string, unknown>;
  rule: {
    id: string;
    name: string;
    project_id: string;
    // Carried into ctx by the dispatcher so deliverWebhook doesn't have
    // to re-SELECT the rule for every fire_webhook action. Nullable
    // because legacy rules pre-4.1 may have a null secret column.
    webhook_secret: string | null;
  };
  // Resolved at dispatch time. Single user shared across every firing.
  rules_engine_user_id: string;
  rulesEngineActor: UserRef;
};

export type EvaluationOutcome = {
  matched: boolean;
  // Populated when matched = false to give the firings log a "why" line.
  reason?: string;
};

export type ActionOutcome = RuleFiringActionResult;

export type FiringOutcome = {
  status: "succeeded" | "failed" | "skipped";
  result_summary: RuleFiringResultSummary;
  last_error: string | null;
};

// Re-exports so callers can import everything from one place.
export type { RuleAction, RuleConditions };
