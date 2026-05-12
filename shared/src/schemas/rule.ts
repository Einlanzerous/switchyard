import { z } from "zod";
import { Uuid, Iso8601, Timestamps } from "./common.js";
import { EventType } from "./event.js";
import { Priority } from "./ticket.js";
import { StatusCategory, Resolution } from "./status.js";

// ─── condition DSL ──────────────────────────────────────────────────────────
//
// One-level nesting only — the form-builder UI in Phase 4.3 leans on this
// flatness. A top-level group is `all` (AND) or `any` (OR); its items are
// either leaf comparisons or a single nested inverse group.

export const RuleConditionOp = z.enum([
  "eq", "ne", "in", "not_in", "contains", "is_null", "is_not_null",
]);
export type RuleConditionOp = z.infer<typeof RuleConditionOp>;

// `field` is a dot-path against the event payload (the webhook envelope:
// `actor`, `ticket`, `changes`, plus event-specific extras). `ticket.labels[].name`
// projects across an array — "any label name matches".
export const RuleConditionLeaf = z.object({
  field: z.string().min(1).max(200),
  op: RuleConditionOp,
  value: z.unknown().optional(),
});
export type RuleConditionLeaf = z.infer<typeof RuleConditionLeaf>;

// Inner group: only leaves, no further nesting.
const InnerAll = z.object({ all: z.array(RuleConditionLeaf).min(1) });
const InnerAny = z.object({ any: z.array(RuleConditionLeaf).min(1) });

// Top-level group: leaves OR one inverse-kind nested group.
export const RuleConditionGroup = z.union([
  z.object({ all: z.array(z.union([RuleConditionLeaf, InnerAny])).min(1) }),
  z.object({ any: z.array(z.union([RuleConditionLeaf, InnerAll])).min(1) }),
]);
export type RuleConditionGroup = z.infer<typeof RuleConditionGroup>;

// `{}` is "always true" — useful when a rule fires on event type alone.
export const RuleConditions = z.union([
  z.object({}).strict(),
  RuleConditionGroup,
]);
export type RuleConditions = z.infer<typeof RuleConditions>;

// ─── actions ────────────────────────────────────────────────────────────────
//
// 4.0 ships set_field / add_label / comment. 4.1 adds assign / move_status /
// fire_webhook / call_n8n.

// Whitelisted target fields for set_field. Anything under `metadata.` is
// allowed (free-form bag).
const SetFieldField = z.union([
  z.literal("priority"),
  z.literal("due_date"),
  z.literal("parent_id"),
  z.string().regex(/^metadata\.[A-Za-z0-9_.-]+$/, "must be a `metadata.<key>` path"),
]);

export const SetFieldAction = z.object({
  type: z.literal("set_field"),
  field: SetFieldField,
  // Loosely typed at the schema layer; the action runner validates per-field.
  // `priority` → Priority enum; `due_date` → ISO8601 or null; `parent_id` →
  // Uuid or null; `metadata.*` → anything.
  value: z.union([z.string(), z.number(), z.boolean(), z.null(), z.record(z.unknown())]),
});
export type SetFieldAction = z.infer<typeof SetFieldAction>;

export const AddLabelAction = z.object({
  type: z.literal("add_label"),
  // Label is referenced by name — created if missing so a freshly-installed
  // rule doesn't fail because its label hasn't been seeded yet.
  label: z.string().min(1).max(50),
  // Optional hex color used only when creating the label for the first time.
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
});
export type AddLabelAction = z.infer<typeof AddLabelAction>;

export const CommentAction = z.object({
  type: z.literal("comment"),
  // Supports `{{ticket.key}}`, `{{actor.name}}`, `{{rule.name}}`, and any
  // dot-path from the event payload (e.g. `{{changes.status.to.display_name}}`).
  body: z.string().min(1).max(50_000),
});
export type CommentAction = z.infer<typeof CommentAction>;

// Assign the ticket to a user, referenced by name OR id (the runner resolves).
// Use "unassign" or omit `user` to clear the assignee.
export const AssignAction = z.object({
  type: z.literal("assign"),
  user: z.string().min(1).max(100).nullable(),
});
export type AssignAction = z.infer<typeof AssignAction>;

// Transition the ticket to a category. The runner picks the default status
// for that category in the ticket's project, then runs through the same
// transition validation /v1/tickets/{id}/transition uses (transitions table,
// epic-close guard, resolution requirement for closed). Optional `to_status`
// targets a specific status by display_name when a project has multiple in
// the same category.
export const MoveStatusAction = z.object({
  type: z.literal("move_status"),
  to_category: StatusCategory,
  to_status: z.string().min(1).max(50).optional(),
  // Required when to_category = 'closed' — same constraint as /transition.
  resolution: Resolution.optional(),
});
export type MoveStatusAction = z.infer<typeof MoveStatusAction>;

// Arbitrary HTTP POST. Body is the standard Event envelope; signed with the
// rule's `webhook_secret` (returned ONCE on rule creation). Headers map is
// optional — useful for receivers that need a static auth header alongside
// the HMAC signature.
export const FireWebhookAction = z.object({
  type: z.literal("fire_webhook"),
  url: z.string().url(),
  method: z.enum(["POST", "PUT"]).default("POST"),
  headers: z.record(z.string()).optional(),
});
export type FireWebhookAction = z.infer<typeof FireWebhookAction>;

// Convenience wrapper around fire_webhook. The runner POSTs to
// `${N8N_BASE_URL}${workflow}` with the same Event envelope, HMAC-signed
// with the rule's webhook_secret. Keeps n8n flow registration out of
// each individual rule.
export const CallN8nAction = z.object({
  type: z.literal("call_n8n"),
  // Path component of the n8n webhook URL (e.g. "/webhook/triage-bug").
  // The server prefixes with N8N_BASE_URL.
  workflow: z.string().min(1).max(500),
});
export type CallN8nAction = z.infer<typeof CallN8nAction>;

export const RuleAction = z.discriminatedUnion("type", [
  SetFieldAction,
  AddLabelAction,
  CommentAction,
  AssignAction,
  MoveStatusAction,
  FireWebhookAction,
  CallN8nAction,
]);
export type RuleAction = z.infer<typeof RuleAction>;

// ─── rule ───────────────────────────────────────────────────────────────────

// ─── scheduled-rule target query (Phase 4.2) ───────────────────────────────
//
// Subset of the /v1/tickets list filters that makes sense for "find tickets
// to operate on at scheduler time". Timestamps are absolute ISO8601 in 4.2 —
// relative-time helpers (`updated_before: "30d ago"`) can land later when
// the use case shows up. Cursor/limit are omitted intentionally; the
// scheduler fires once per matched ticket and the per-rule rate limit
// (RULE_RATE_LIMIT_PER_HOUR) is the safety net for huge result sets.

export const ScheduledRuleTarget = z.object({
  project: z.string().optional(),       // project key or comma-separated
  status: z.string().optional(),        // status id OR category OR comma-separated
  type: z.string().optional(),
  label: z.string().optional(),
  assignee: z.string().optional(),      // user id OR "unassigned"
  reporter: z.string().optional(),
  parent_id: Uuid.optional(),
  text: z.string().optional(),
  updated_after: Iso8601.optional(),
  updated_before: Iso8601.optional(),
});
export type ScheduledRuleTarget = z.infer<typeof ScheduledRuleTarget>;

export const Rule = z
  .object({
    id: Uuid,
    // NULL = global rule (matches every project), 4.1+. Project-scoped rules
    // only fire on events in their project.
    project_id: Uuid.nullable(),
    name: z.string().min(1).max(200),
    enabled: z.boolean(),
    // Event-triggered: array non-empty + schedule_cron null.
    // Scheduled:      array empty       + schedule_cron set.
    // Enforced by DB CHECK + CreateRule refine.
    trigger_event_types: z.array(EventType),
    conditions: RuleConditions,
    actions: z.array(RuleAction).min(1).max(10),
    // ─── scheduled-rule fields ──────────────────────────────────────
    schedule_cron: z.string().min(1).max(120).nullable(),
    schedule_tz: z.string().min(1).max(80).nullable(),
    target_query: ScheduledRuleTarget.nullable(),
    last_fired_at: Iso8601.nullable(),
  })
  .merge(Timestamps);
export type Rule = z.infer<typeof Rule>;

// Returned ONCE on POST /v1/rules. Subsequent reads use Rule (no secret).
// Mirrors WebhookSubscriptionWithSecret.
export const RuleWithSecret = Rule.extend({
  webhook_secret: z.string(),
});
export type RuleWithSecret = z.infer<typeof RuleWithSecret>;

// Refine helper: exactly one trigger mode must be set. Used by both
// CreateRule and UpdateRule (the latter when both fields are present).
function refineTriggerXor<T extends { trigger_event_types?: unknown[]; schedule_cron?: string | null }>(
  data: T,
  ctx: z.RefinementCtx,
) {
  const hasEvents = Array.isArray(data.trigger_event_types) && data.trigger_event_types.length > 0;
  const hasCron = typeof data.schedule_cron === "string" && data.schedule_cron.length > 0;
  if (hasEvents && hasCron) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "exactly one of trigger_event_types or schedule_cron must be set, not both",
      path: ["trigger_event_types"],
    });
  }
  if (!hasEvents && !hasCron) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "either trigger_event_types (non-empty) or schedule_cron is required",
      path: ["trigger_event_types"],
    });
  }
}

export const CreateRule = z
  .object({
    // null = global rule (Phase 4.1+).
    project_id: Uuid.nullable().optional(),
    name: z.string().min(1).max(200),
    enabled: z.boolean().default(true),
    trigger_event_types: z.array(EventType).default([]),
    conditions: RuleConditions.default({}),
    actions: z.array(RuleAction).min(1).max(10),
    // ─── scheduled-rule fields ──────────────────────────────────────
    schedule_cron: z.string().min(1).max(120).optional(),
    schedule_tz: z.string().min(1).max(80).optional(),
    target_query: ScheduledRuleTarget.optional(),
  })
  .superRefine(refineTriggerXor);
export type CreateRule = z.infer<typeof CreateRule>;

export const UpdateRule = z
  .object({
    name: z.string().min(1).max(200).optional(),
    enabled: z.boolean().optional(),
    trigger_event_types: z.array(EventType).optional(),
    conditions: RuleConditions.optional(),
    actions: z.array(RuleAction).min(1).max(10).optional(),
    schedule_cron: z.string().min(1).max(120).nullable().optional(),
    schedule_tz: z.string().min(1).max(80).nullable().optional(),
    target_query: ScheduledRuleTarget.nullable().optional(),
  })
  .superRefine((data, ctx) => {
    // Only validate XOR when both knobs are present in this patch — partial
    // patches that touch one or neither pass through, and the DB CHECK
    // catches any resulting inconsistency.
    if (data.trigger_event_types !== undefined && data.schedule_cron !== undefined) {
      refineTriggerXor(data, ctx);
    }
  });
export type UpdateRule = z.infer<typeof UpdateRule>;

// ─── firings ────────────────────────────────────────────────────────────────

export const RuleFiringStatus = z.enum([
  "pending", "running", "succeeded", "failed", "abandoned", "skipped",
]);
export type RuleFiringStatus = z.infer<typeof RuleFiringStatus>;

export const RuleFiringActionResult = z.object({
  type: z.string(),
  status: z.enum(["ok", "error"]),
  error: z.string().nullable().optional(),
});
export type RuleFiringActionResult = z.infer<typeof RuleFiringActionResult>;

export const RuleFiringResultSummary = z.object({
  conditions_matched: z.boolean().optional(),
  actions: z.array(RuleFiringActionResult).optional(),
  // Populated when status = 'skipped' (conditions false, rule disabled mid-flight, etc.).
  skip_reason: z.string().optional(),
});
export type RuleFiringResultSummary = z.infer<typeof RuleFiringResultSummary>;

export const RuleFiring = z.object({
  id: Uuid,
  rule_id: Uuid,
  // event_id set for event-triggered firings (4.0); null for scheduled.
  event_id: Uuid.nullable(),
  // ticket_id set for scheduled firings (4.2+) — the ticket matched by
  // the rule's target_query at scheduler-tick time; null for event-
  // triggered (the ticket comes from the event payload).
  ticket_id: Uuid.nullable(),
  status: RuleFiringStatus,
  attempts: z.number().int().nonnegative(),
  last_error: z.string().nullable(),
  last_attempt_at: Iso8601.nullable(),
  next_attempt_at: Iso8601.nullable(),
  result_summary: RuleFiringResultSummary.nullable(),
  created_at: Iso8601,
});
export type RuleFiring = z.infer<typeof RuleFiring>;

// Re-export Priority so the SettingsApp UI can reuse the same enum for the
// set_field value picker without re-importing it from ./ticket.
export { Priority };
