// DB row → API shape transforms.
//
// Centralized so the same mapping is used by list and detail handlers, and
// so the API contract surface stays in one place to audit.

import type {
  User, UserRef, Project, ProjectRef, Status, StatusRef,
  Label, LabelRef, TicketSummary, Ticket, Comment, Attachment, Event as ApiEvent,
  Resolution, TicketType, Priority, EventType, AttachmentKind, StatusCategory,
  ApiToken, TicketLink, TicketLinkType, TicketLinkDirection,
  CustomField as ApiCustomField, CustomFieldType as ApiCustomFieldType,
  CustomFieldOptions as ApiCustomFieldOptions,
  ExternalRef as ApiExternalRef, ExternalRefKind as ApiExternalRefKind,
  ExternalRefState as ApiExternalRefState,
  TicketTemplate as ApiTicketTemplate,
  OverlapPolicy as ApiOverlapPolicy,
  ScheduleMode as ApiScheduleMode,
  ProjectMember, ProjectRole,
} from "@switchyard/shared";
import * as schema from "../../drizzle/schema.js";
import { env } from "../env.js";

type UserRow = typeof schema.users.$inferSelect;
type ProjectRow = typeof schema.projects.$inferSelect;
type StatusRow = typeof schema.statuses.$inferSelect;
type LabelRow = typeof schema.labels.$inferSelect;
type TicketRow = typeof schema.tickets.$inferSelect;
type CommentRow = typeof schema.comments.$inferSelect;
type AttachmentRow = typeof schema.attachments.$inferSelect;
type EventRow = typeof schema.events.$inferSelect;
type TokenRow = typeof schema.apiTokens.$inferSelect;

// ─── users ─────────────────────────────────────────────────────────────────

export function mapUser(u: UserRow): User {
  return {
    id: u.id,
    name: u.name,
    icon: u.icon,
    type: u.type,
    instance_role: u.instance_role,
    email: u.email,
    created_at: u.created_at,
    updated_at: u.updated_at,
    deleted_at: u.deleted_at,
  };
}

export function mapUserRef(u: UserRow): UserRef {
  return { id: u.id, name: u.name, icon: u.icon, type: u.type };
}

// Phase 6.4 — a `user_projects` row joined to its user.
export function mapProjectMember(
  u: UserRow,
  role: ProjectRole,
  created_at: string,
): ProjectMember {
  return { user: mapUserRef(u), role, created_at };
}

// ─── projects ──────────────────────────────────────────────────────────────

export function mapProject(p: ProjectRow): Project {
  return {
    id: p.id,
    key: p.key,
    name: p.name,
    description: p.description,
    color: p.color,
    repo_url: p.repo_url,
    default_test_cmd: p.default_test_cmd,
    archived_at: p.archived_at,
    board_closed_window_days: (p.board_closed_window_days ?? null) as Project["board_closed_window_days"],
    created_at: p.created_at,
    updated_at: p.updated_at,
    deleted_at: p.deleted_at,
  };
}

export function mapProjectRef(p: ProjectRow): ProjectRef {
  return { id: p.id, key: p.key, name: p.name, color: p.color, repo_url: p.repo_url };
}

// ─── statuses ──────────────────────────────────────────────────────────────

export function mapStatus(s: StatusRow): Status {
  return {
    id: s.id,
    project_id: s.project_id,
    category: s.category as StatusCategory,
    display_name: s.display_name,
    position: s.position,
    is_default: s.is_default,
    created_at: s.created_at,
    updated_at: s.updated_at,
  };
}

export function mapStatusRef(s: StatusRow): StatusRef {
  return {
    id: s.id,
    category: s.category as StatusCategory,
    display_name: s.display_name,
  };
}

// ─── labels ────────────────────────────────────────────────────────────────

export function mapLabel(l: LabelRow): Label {
  return {
    id: l.id,
    name: l.name,
    color: l.color,
    created_at: l.created_at,
    updated_at: l.updated_at,
  };
}

function mapLabelRef(l: LabelRow): LabelRef {
  return { id: l.id, name: l.name, color: l.color };
}

// ─── attachments ───────────────────────────────────────────────────────────

export function mapAttachment(a: AttachmentRow, uploader: UserRow): Attachment {
  return {
    id: a.id,
    ticket_id: a.ticket_id,
    comment_id: a.comment_id,
    kind: a.kind as AttachmentKind,
    mime_type: a.mime_type,
    size_bytes: a.size_bytes,
    original_name: a.original_name,
    url: `${env.PUBLIC_URL}/v1/attachments/${a.id}`,
    transcript: a.transcript,
    uploaded_by: mapUserRef(uploader),
    created_at: a.created_at,
  };
}

// ─── comments ──────────────────────────────────────────────────────────────

export function mapComment(c: CommentRow, author: UserRow, attachments: Attachment[]): Comment {
  const deleted = c.deleted_at != null;
  // Tombstoned comments stay in-thread as a placeholder: redact the body and
  // drop attachments so deleted content never leaks. The "[deleted]" string
  // also satisfies the Comment.body min(1) floor.
  const edited = !deleted && c.updated_at > c.created_at;
  return {
    id: c.id,
    ticket_id: c.ticket_id,
    author: mapUserRef(author),
    body: deleted ? "[deleted]" : c.body,
    attachments: deleted ? [] : attachments,
    // Plan-thread anchoring (Phase 7); null for ordinary ticket comments.
    plan_revision_id: c.plan_revision_id ?? null,
    plan_anchor: (c.plan_anchor as Comment["plan_anchor"]) ?? null,
    edited,
    deleted,
    created_at: c.created_at,
    updated_at: c.updated_at,
    deleted_at: c.deleted_at,
  };
}

// ─── ticket links ──────────────────────────────────────────────────────────

type TicketLinkRow = typeof schema.ticketLinks.$inferSelect;

// Caller supplies the viewing ticket (so we can pick `direction`) plus
// the "other" ticket's project (for the key) and the creator. We don't
// embed the verb here — UI picks it from (type, direction).
export type TicketLinkDeps = {
  viewingTicketId: string;
  otherTicket: { id: string; number: number };
  otherProjectKey: string;
  otherTitle: string;
  creator: UserRow;
};

export function mapTicketLink(row: TicketLinkRow, deps: TicketLinkDeps): TicketLink {
  const direction: TicketLinkDirection =
    row.source_ticket_id === deps.viewingTicketId ? "outgoing" : "incoming";
  return {
    id: row.id,
    type: row.type as TicketLinkType,
    direction,
    other_ticket: {
      id: deps.otherTicket.id,
      key: `${deps.otherProjectKey}-${deps.otherTicket.number}`,
      title: deps.otherTitle,
    },
    created_at: row.created_at,
    created_by: mapUserRef(deps.creator),
  };
}

// ─── external refs ─────────────────────────────────────────────────────────

type ExternalRefRow = typeof schema.ticketExternalRefs.$inferSelect;

export function mapExternalRef(row: ExternalRefRow, creator: UserRow): ApiExternalRef {
  return {
    id: row.id,
    ticket_id: row.ticket_id,
    kind: row.kind as ApiExternalRefKind,
    url: row.url,
    state: (row.state ?? null) as ApiExternalRefState | null,
    title: row.title,
    polled_at: row.polled_at,
    polled_state_changed_at: row.polled_state_changed_at,
    created_at: row.created_at,
    created_by: mapUserRef(creator),
  };
}

// ─── tickets ───────────────────────────────────────────────────────────────

export type TicketSummaryDeps = {
  project: ProjectRow;
  status: StatusRow;
  assignee: UserRow | null;
  reporter: UserRow;
  labels: LabelRow[];
  number: number;
  parent?: { id: string; key: string; title: string } | null;
  // External refs touching this ticket. List endpoints batch-fetch
  // these and feed them in per-ticket; single-ticket loads call
  // `loadTicketLinks`-style helpers. Empty when no refs are attached.
  externalRefs: ApiExternalRef[];
  // Direct-subtask rollup, batch-computed by board/list endpoints. Omitted on
  // single-ticket loads (defaults to null — no subtasks surfaced on the card).
  subtaskCounts?: { total: number; done: number } | null;
};

export function mapTicketSummary(t: TicketRow, deps: TicketSummaryDeps): TicketSummary {
  return {
    id: t.id,
    key: `${deps.project.key}-${t.number}`,
    number: t.number,
    project: mapProjectRef(deps.project),
    type: t.type as TicketType,
    title: t.title,
    status: mapStatusRef(deps.status),
    resolution: (t.resolution ?? null) as Resolution | null,
    priority: (t.priority ?? null) as Priority | null,
    parent_id: t.parent_id,
    parent: deps.parent ?? null,
    assignee: deps.assignee ? mapUserRef(deps.assignee) : null,
    reporter: mapUserRef(deps.reporter),
    due_date: t.due_date,
    labels: deps.labels.map(mapLabelRef),
    position: t.position,
    external_refs: deps.externalRefs,
    template_id: t.template_id,
    subtasks: deps.subtaskCounts ?? null,
    created_at: t.created_at,
    updated_at: t.updated_at,
    deleted_at: t.deleted_at,
  };
}

export type TicketDetailDeps = TicketSummaryDeps & {
  comments: Comment[];
  ticketAttachments: Attachment[];
  commentAttachments: Attachment[];
  links: TicketLink[];
};

export function mapTicket(t: TicketRow, deps: TicketDetailDeps): Ticket {
  const summary = mapTicketSummary(t, deps);
  const all = [...deps.ticketAttachments, ...deps.commentAttachments].sort((a, b) =>
    a.created_at < b.created_at ? -1 : 1
  );
  return {
    ...summary,
    description: t.description,
    metadata: (t.metadata as Record<string, unknown>) ?? {},
    comments: deps.comments,
    attachments: deps.ticketAttachments,
    all_attachments: all,
    links: deps.links,
  };
}

// ─── events ────────────────────────────────────────────────────────────────

// events.payload contains the snapshot we wrote in writeEvent: { actor, ticket, changes, ...extras }
type EventPayload = {
  actor?: UserRef | null;
  ticket?: TicketSummary | null;
  changes?: ApiEvent["changes"];
  [k: string]: unknown;
};

export function mapEvent(e: EventRow): ApiEvent {
  const p = (e.payload ?? {}) as EventPayload;
  // The webhook envelope adds occurred_at = now() at delivery time, but the
  // events API surfaces created_at directly.
  return {
    id: e.id,
    event: e.event_type as EventType,
    occurred_at: e.created_at,
    actor: (p.actor ?? null) as UserRef | null,
    ticket: (p.ticket ?? null) as TicketSummary | null,
    changes: p.changes,
    payload: stripEnvelopeFields(p),
  };
}

function stripEnvelopeFields(p: EventPayload): Record<string, unknown> | undefined {
  const { actor, ticket, changes, ...rest } = p;
  void actor;
  void ticket;
  void changes;
  return Object.keys(rest).length > 0 ? rest : undefined;
}

// ─── api tokens ────────────────────────────────────────────────────────────

// ─── webhooks ──────────────────────────────────────────────────────────────

type WebhookSubRow = typeof schema.webhookSubscriptions.$inferSelect;
type WebhookDeliveryRow = typeof schema.webhookDeliveries.$inferSelect;

import type {
  WebhookSubscription as ApiWebhookSubscription,
  WebhookSubscriptionWithSecret as ApiWebhookSubscriptionWithSecret,
  WebhookDelivery as ApiWebhookDelivery,
} from "@switchyard/shared";

export function mapWebhookSubscription(s: WebhookSubRow): ApiWebhookSubscription {
  return {
    id: s.id,
    url: s.url,
    event_types: s.event_types as ApiWebhookSubscription["event_types"],
    status_filter: (s.status_filter ?? null) as ApiWebhookSubscription["status_filter"],
    target_id: s.target_id,
    active: s.active,
    created_at: s.created_at,
    updated_at: s.updated_at,
  };
}

export function mapWebhookSubscriptionWithSecret(s: WebhookSubRow): ApiWebhookSubscriptionWithSecret {
  return { ...mapWebhookSubscription(s), secret: s.secret };
}

export function mapWebhookDelivery(d: WebhookDeliveryRow): ApiWebhookDelivery {
  return {
    id: d.id,
    subscription_id: d.subscription_id,
    event_id: d.event_id,
    status: d.status as ApiWebhookDelivery["status"],
    response_code: d.response_code,
    response_body_excerpt: d.response_body_excerpt,
    attempts: d.attempts,
    last_error: d.last_error,
    last_attempt_at: d.last_attempt_at,
    next_attempt_at: d.next_attempt_at,
    created_at: d.created_at,
  };
}

// ─── api tokens ────────────────────────────────────────────────────────────

// ─── rules (Phase 4) ───────────────────────────────────────────────────────

type RuleRow = typeof schema.rules.$inferSelect;
type RuleFiringRow = typeof schema.ruleFirings.$inferSelect;

import type {
  Rule as ApiRule, RuleWithSecret as ApiRuleWithSecret,
  RuleFiring as ApiRuleFiring,
  RuleAction as ApiRuleAction, RuleConditions as ApiRuleConditions,
  RuleFiringResultSummary as ApiRuleFiringSummary,
  ScheduledRuleTarget as ApiScheduledRuleTarget,
} from "@switchyard/shared";

export function mapRule(r: RuleRow): ApiRule {
  return {
    id: r.id,
    project_id: r.project_id,
    name: r.name,
    enabled: r.enabled,
    trigger_event_types: r.trigger_event_types as ApiRule["trigger_event_types"],
    conditions: (r.conditions ?? {}) as ApiRuleConditions,
    actions: (r.actions ?? []) as ApiRuleAction[],
    schedule_cron: r.schedule_cron,
    schedule_tz: r.schedule_tz,
    target_query: (r.target_query ?? null) as ApiScheduledRuleTarget | null,
    last_fired_at: r.last_fired_at,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

// Used ONLY by POST /v1/rules — every other surface returns mapRule()
// without the secret. Throws when the column is unexpectedly null
// (shouldn't happen post-4.1 since create always populates).
export function mapRuleWithSecret(r: RuleRow): ApiRuleWithSecret {
  if (!r.webhook_secret) {
    throw new Error("rule has no webhook_secret — cannot map with secret");
  }
  return { ...mapRule(r), webhook_secret: r.webhook_secret };
}

export function mapRuleFiring(f: RuleFiringRow): ApiRuleFiring {
  return {
    id: f.id,
    rule_id: f.rule_id,
    event_id: f.event_id,
    ticket_id: f.ticket_id,
    status: f.status as ApiRuleFiring["status"],
    attempts: f.attempts,
    last_error: f.last_error,
    last_attempt_at: f.last_attempt_at,
    next_attempt_at: f.next_attempt_at,
    result_summary: (f.result_summary ?? null) as ApiRuleFiringSummary | null,
    created_at: f.created_at,
  };
}

type TicketTemplateRow = typeof schema.ticketTemplates.$inferSelect;

// Build the API shape from a template row + its project row + optional
// assignee row. Mode is derived from which schedule field is populated
// (the DB enforces XOR via CHECK, so this is unambiguous).
export function mapTicketTemplate(
  t: TicketTemplateRow,
  deps: { project: ProjectRow; assignee: UserRow | null }
): ApiTicketTemplate {
  return {
    id: t.id,
    project: mapProjectRef(deps.project),
    enabled: t.enabled,
    title: t.title,
    description: t.description,
    type: t.type as TicketType,
    priority: t.priority as Priority | null,
    assignee: deps.assignee ? mapUserRef(deps.assignee) : null,
    parent_id: t.parent_id,
    label_ids: (t.label_ids ?? []) as string[],
    metadata: (t.metadata ?? {}) as Record<string, unknown>,
    due_date_offset_days: t.due_date_offset_days,
    mode: (t.schedule_cron ? "recurring" : "one_shot") as ApiScheduleMode,
    schedule_cron: t.schedule_cron,
    schedule_tz: t.schedule_tz,
    trigger_at: t.trigger_at,
    lead_days: t.lead_days,
    overlap_policy: t.overlap_policy as ApiOverlapPolicy,
    last_fired_at: t.last_fired_at,
    created_at: t.created_at,
    updated_at: t.updated_at,
  };
}

export function mapApiToken(t: TokenRow): ApiToken {
  return {
    id: t.id,
    user_id: t.user_id,
    name: t.name,
    kind: t.kind,
    scopes: t.scopes as ApiToken["scopes"],
    last_used_at: t.last_used_at,
    revoked_at: t.revoked_at,
    created_at: t.created_at,
    updated_at: t.updated_at,
  };
}

// ─── custom fields ─────────────────────────────────────────────────────────

type CustomFieldRow = typeof schema.customFields.$inferSelect;

export function mapCustomField(f: CustomFieldRow): ApiCustomField {
  return {
    id: f.id,
    project_id: f.project_id,
    key: f.key,
    label: f.label,
    type: f.type as ApiCustomFieldType,
    options: (f.options ?? null) as ApiCustomFieldOptions | null,
    show_on_card: f.show_on_card,
    show_on_create_form: f.show_on_create_form,
    show_on_filter_bar: f.show_on_filter_bar,
    created_at: f.created_at,
    updated_at: f.updated_at,
  };
}
