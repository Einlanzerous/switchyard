import { sql } from "drizzle-orm";
import {
  pgEnum,
  pgTable,
  uuid,
  text,
  varchar,
  timestamp,
  boolean,
  integer,
  bigint,
  doublePrecision,
  jsonb,
  primaryKey,
  uniqueIndex,
  index,
  check,
} from "drizzle-orm/pg-core";

// ─── Enums ──────────────────────────────────────────────────────────────────

export const userType = pgEnum("user_type", ["agent", "human"]);
export const statusCategory = pgEnum("status_category", [
  "backlog",
  "planning",
  "in_progress",
  "blocked",
  "closed",
]);
export const resolution = pgEnum("resolution", ["done", "released", "cancelled"]);
export const ticketType = pgEnum("ticket_type", ["spike", "task", "bug", "epic"]);
export const priority = pgEnum("priority", ["low", "medium", "high", "critical"]);
export const attachmentKind = pgEnum("attachment_kind", ["image", "audio", "text"]);
export const boardLayout = pgEnum("board_layout", ["kanban", "list"]);
export const webhookDeliveryStatus = pgEnum("webhook_delivery_status", [
  "pending",
  "delivering",
  "succeeded",
  "failed",
  "abandoned",
]);

// ─── Common columns ─────────────────────────────────────────────────────────

const id = () => uuid("id").primaryKey().defaultRandom();
const createdAt = () =>
  timestamp("created_at", { withTimezone: true, mode: "string" })
    .notNull()
    .default(sql`now()`);
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true, mode: "string" })
    .notNull()
    .default(sql`now()`);
const deletedAt = () =>
  timestamp("deleted_at", { withTimezone: true, mode: "string" });

// ─── users / membership ─────────────────────────────────────────────────────

export const users = pgTable(
  "users",
  {
    id: id(),
    name: varchar("name", { length: 100 }).notNull(),
    icon: varchar("icon", { length: 500 }),
    type: userType("type").notNull(),
    created_at: createdAt(),
    updated_at: updatedAt(),
    deleted_at: deletedAt(),
  },
  (t) => ({
    nameUnique: uniqueIndex("users_name_unique").on(t.name).where(sql`${t.deleted_at} IS NULL`),
  })
);

// ─── projects + per-project ticket counter ─────────────────────────────────

export const projects = pgTable(
  "projects",
  {
    id: id(),
    key: varchar("key", { length: 10 }).notNull(),
    name: varchar("name", { length: 200 }).notNull(),
    description: text("description"),
    color: varchar("color", { length: 7 }),
    archived_at: timestamp("archived_at", { withTimezone: true, mode: "string" }),
    created_at: createdAt(),
    updated_at: updatedAt(),
    deleted_at: deletedAt(),
  },
  (t) => ({
    keyUnique: uniqueIndex("projects_key_unique").on(t.key),
    keyShape: check("projects_key_shape", sql`${t.key} ~ '^[A-Z][A-Z0-9]{1,9}$'`),
  })
);

export const userProjects = pgTable(
  "user_projects",
  {
    user_id: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    project_id: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    created_at: createdAt(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.user_id, t.project_id] }),
  })
);

// Per-project ticket counter. Increment-then-return:
//   UPDATE project_counters SET last_used_number = last_used_number + 1
//     WHERE project_id = $1 RETURNING last_used_number
// The returned value is the new ticket's number.
export const projectCounters = pgTable("project_counters", {
  project_id: uuid("project_id")
    .primaryKey()
    .references(() => projects.id, { onDelete: "cascade" }),
  last_used_number: integer("last_used_number").notNull().default(0),
});

// ─── statuses + transitions ─────────────────────────────────────────────────

export const statuses = pgTable(
  "statuses",
  {
    id: id(),
    project_id: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    category: statusCategory("category").notNull(),
    display_name: varchar("display_name", { length: 50 }).notNull(),
    position: integer("position").notNull().default(0),
    is_default: boolean("is_default").notNull().default(false),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (t) => ({
    nameUnique: uniqueIndex("statuses_project_display_name_unique").on(t.project_id, t.display_name),
    projectIdx: index("statuses_project_idx").on(t.project_id, t.position),
  })
);

export const statusTransitions = pgTable(
  "status_transitions",
  {
    id: id(),
    project_id: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    // NULL from_status_id means "any source"
    from_status_id: uuid("from_status_id").references(() => statuses.id, {
      onDelete: "cascade",
    }),
    to_status_id: uuid("to_status_id")
      .notNull()
      .references(() => statuses.id, { onDelete: "cascade" }),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (t) => ({
    edgeUnique: uniqueIndex("status_transitions_edge_unique").on(
      t.project_id,
      t.from_status_id,
      t.to_status_id
    ),
  })
);

// ─── labels ─────────────────────────────────────────────────────────────────
//
// Labels are GLOBAL — a single shared catalog spans all projects. Cross-cutting
// concerns ("frontend", "urgent", "docs") apply uniformly without per-project
// duplication. The migration in 0002_global_labels.sql dedupes any
// project-scoped duplicates from the previous schema before dropping the
// project_id column.

export const labels = pgTable(
  "labels",
  {
    id: id(),
    name: varchar("name", { length: 50 }).notNull(),
    color: varchar("color", { length: 7 }).notNull(),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (t) => ({
    nameUnique: uniqueIndex("labels_name_unique").on(t.name),
  })
);

// ─── tickets ────────────────────────────────────────────────────────────────

export const tickets = pgTable(
  "tickets",
  {
    id: id(),
    project_id: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    number: integer("number").notNull(),
    type: ticketType("type").notNull(),
    title: varchar("title", { length: 500 }).notNull(),
    description: text("description").notNull().default(""),
    status_id: uuid("status_id")
      .notNull()
      .references(() => statuses.id, { onDelete: "restrict" }),
    resolution: resolution("resolution"),
    priority: priority("priority"),
    parent_id: uuid("parent_id").references((): any => tickets.id, { onDelete: "set null" }),
    assignee_id: uuid("assignee_id").references(() => users.id, { onDelete: "set null" }),
    reporter_id: uuid("reporter_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    due_date: timestamp("due_date", { withTimezone: true, mode: "string" }),
    // Manual sort order within a column. Higher number = higher in column.
    // Backfilled to epoch_ms(updated_at) on first migrate (see triggers.sql)
    // so existing tickets keep their date-descending order without any
    // explicit reorder. New rows get position = epoch_ms(now()) at insert.
    position: doublePrecision("position"),
    metadata: jsonb("metadata").notNull().default({}),
    created_at: createdAt(),
    updated_at: updatedAt(),
    deleted_at: deletedAt(),
  },
  (t) => ({
    projectNumberUnique: uniqueIndex("tickets_project_number_unique").on(t.project_id, t.number),
    statusIdx: index("tickets_status_idx").on(t.status_id),
    assigneeIdx: index("tickets_assignee_idx").on(t.assignee_id),
    parentIdx: index("tickets_parent_idx").on(t.parent_id),
    updatedIdx: index("tickets_updated_idx").on(t.updated_at),
    positionIdx: index("tickets_position_idx").on(t.status_id, t.position),
    noSelfParent: check("tickets_no_self_parent", sql`${t.id} <> ${t.parent_id}`),
  })
);

export const ticketLabels = pgTable(
  "ticket_labels",
  {
    ticket_id: uuid("ticket_id")
      .notNull()
      .references(() => tickets.id, { onDelete: "cascade" }),
    label_id: uuid("label_id")
      .notNull()
      .references(() => labels.id, { onDelete: "cascade" }),
  },
  (t) => ({ pk: primaryKey({ columns: [t.ticket_id, t.label_id] }) })
);

// ─── ticket links (typed cross-ticket relations) ───────────────────────────
//
// Separate primitive from `parent_id` (which encodes epic→child only,
// one level deep, with a postgres trigger). Link rows are stored once
// from the source side; the GET handler unions source + target lookups
// so both tickets see the link, and a verb table flips the rendered
// preposition based on direction.
//
// Verbs:
//   blocks       → forward "blocks",       inverse "is blocked by"
//   relates_to   → forward "relates to",   inverse "relates to"   (symmetric)
//   duplicates   → forward "duplicates",   inverse "is duplicated by"

export const ticketLinkType = pgEnum("ticket_link_type", [
  "blocks", "relates_to", "duplicates",
]);

export const ticketLinks = pgTable(
  "ticket_links",
  {
    id: id(),
    source_ticket_id: uuid("source_ticket_id")
      .notNull()
      .references(() => tickets.id, { onDelete: "cascade" }),
    target_ticket_id: uuid("target_ticket_id")
      .notNull()
      .references(() => tickets.id, { onDelete: "cascade" }),
    type: ticketLinkType("type").notNull(),
    created_at: createdAt(),
    created_by: uuid("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
  },
  (t) => ({
    edgeUnique: uniqueIndex("ticket_links_edge_unique").on(
      t.source_ticket_id, t.target_ticket_id, t.type,
    ),
    sourceIdx: index("ticket_links_source_idx").on(t.source_ticket_id),
    targetIdx: index("ticket_links_target_idx").on(t.target_ticket_id),
    noSelfLink: check(
      "ticket_links_no_self_link",
      sql`${t.source_ticket_id} <> ${t.target_ticket_id}`,
    ),
  })
);

// ─── comments ───────────────────────────────────────────────────────────────

export const comments = pgTable(
  "comments",
  {
    id: id(),
    ticket_id: uuid("ticket_id")
      .notNull()
      .references(() => tickets.id, { onDelete: "cascade" }),
    author_id: uuid("author_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    body: text("body").notNull(),
    created_at: createdAt(),
    updated_at: updatedAt(),
    deleted_at: deletedAt(),
  },
  (t) => ({
    ticketIdx: index("comments_ticket_idx").on(t.ticket_id, t.created_at),
  })
);

// ─── attachments ────────────────────────────────────────────────────────────

export const attachments = pgTable(
  "attachments",
  {
    id: id(),
    ticket_id: uuid("ticket_id").references(() => tickets.id, { onDelete: "cascade" }),
    comment_id: uuid("comment_id").references(() => comments.id, { onDelete: "cascade" }),
    kind: attachmentKind("kind").notNull(),
    mime_type: varchar("mime_type", { length: 200 }).notNull(),
    size_bytes: bigint("size_bytes", { mode: "number" }).notNull(),
    storage_path: text("storage_path").notNull(),
    original_name: varchar("original_name", { length: 500 }),
    transcript: text("transcript"),
    uploaded_by: uuid("uploaded_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    created_at: createdAt(),
  },
  (t) => ({
    ticketIdx: index("attachments_ticket_idx").on(t.ticket_id),
    commentIdx: index("attachments_comment_idx").on(t.comment_id),
    parentNotNull: check(
      "attachments_parent_not_null",
      sql`${t.ticket_id} IS NOT NULL OR ${t.comment_id} IS NOT NULL`
    ),
    transcriptOnAudio: check(
      "attachments_transcript_audio_only",
      sql`${t.transcript} IS NULL OR ${t.kind} = 'audio'`
    ),
  })
);

// ─── events (audit + webhook source + chart data) ───────────────────────────

export const events = pgTable(
  "events",
  {
    id: id(),
    ticket_id: uuid("ticket_id").references(() => tickets.id, { onDelete: "set null" }),
    project_id: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
    actor_id: uuid("actor_id").references(() => users.id, { onDelete: "set null" }),
    event_type: varchar("event_type", { length: 80 }).notNull(),
    payload: jsonb("payload").notNull().default({}),
    created_at: createdAt(),
  },
  (t) => ({
    ticketIdx: index("events_ticket_idx").on(t.ticket_id, t.created_at),
    projectIdx: index("events_project_idx").on(t.project_id, t.created_at),
    typeIdx: index("events_type_idx").on(t.event_type, t.created_at),
  })
);

// ─── boards (cross-project saved views) ─────────────────────────────────────

export const boards = pgTable("boards", {
  id: id(),
  name: varchar("name", { length: 200 }).notNull(),
  layout: boardLayout("layout").notNull().default("kanban"),
  filter: jsonb("filter").notNull().default({}),
  created_at: createdAt(),
  updated_at: updatedAt(),
});

export const boardProjects = pgTable(
  "board_projects",
  {
    board_id: uuid("board_id")
      .notNull()
      .references(() => boards.id, { onDelete: "cascade" }),
    project_id: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
  },
  (t) => ({ pk: primaryKey({ columns: [t.board_id, t.project_id] }) })
);

// ─── targets ───────────────────────────────────────────────────────────────
//
// Named webhook endpoints. Decouples URLs from the rules and
// subscriptions that reference them — change a target's URL once and
// every subscription/action pointing at it follows. Receivers verify
// HMAC with `hmac_secret` when present; falls back to the rule's
// webhook_secret for fire_webhook actions when both are unset.

export const targets = pgTable(
  "targets",
  {
    id: id(),
    name: varchar("name", { length: 80 }).notNull(),
    description: text("description"),
    url: text("url").notNull(),
    // Optional target-scoped HMAC secret. When set, beats the rule's
    // webhook_secret for fire_webhook actions. Returned ONCE on POST.
    hmac_secret: text("hmac_secret"),
    // Static headers merged into every outbound request. Per-action
    // headers win on collision.
    headers: jsonb("headers"),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (t) => ({
    // Names are lowercased + validated at the API layer; case-insensitive
    // uniqueness is enforced by storing them lowercased.
    nameUnique: uniqueIndex("targets_name_unique").on(t.name),
  })
);

// ─── webhooks ───────────────────────────────────────────────────────────────

export const webhookSubscriptions = pgTable(
  "webhook_subscriptions",
  {
    id: id(),
    url: text("url").notNull(),
    event_types: text("event_types").array().notNull(),
    status_filter: jsonb("status_filter"),
    secret: text("secret").notNull(),
    // Optional named target. When set, the dispatcher
    // resolves the URL + signing secret from the target at delivery
    // time, overriding the `url`/`secret` columns above. The columns
    // remain so dropping the target falls back to the literal URL.
    target_id: uuid("target_id").references(() => targets.id, { onDelete: "set null" }),
    active: boolean("active").notNull().default(true),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (t) => ({
    activeIdx: index("webhook_subscriptions_active_idx").on(t.active),
    targetIdx: index("webhook_subscriptions_target_idx").on(t.target_id),
  })
);

export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    id: id(),
    subscription_id: uuid("subscription_id")
      .notNull()
      .references(() => webhookSubscriptions.id, { onDelete: "cascade" }),
    event_id: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    status: webhookDeliveryStatus("status").notNull().default("pending"),
    response_code: integer("response_code"),
    response_body_excerpt: text("response_body_excerpt"),
    attempts: integer("attempts").notNull().default(0),
    last_error: text("last_error"),
    last_attempt_at: timestamp("last_attempt_at", { withTimezone: true, mode: "string" }),
    next_attempt_at: timestamp("next_attempt_at", { withTimezone: true, mode: "string" }),
    created_at: createdAt(),
  },
  (t) => ({
    pendingIdx: index("webhook_deliveries_pending_idx")
      .on(t.next_attempt_at)
      .where(sql`${t.status} IN ('pending', 'failed')`),
    subscriptionIdx: index("webhook_deliveries_subscription_idx").on(
      t.subscription_id,
      t.created_at
    ),
  })
);

// ─── api tokens ─────────────────────────────────────────────────────────────

export const apiTokens = pgTable(
  "api_tokens",
  {
    id: id(),
    user_id: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 100 }).notNull(),
    hashed_token: varchar("hashed_token", { length: 200 }).notNull(),
    token_prefix: varchar("token_prefix", { length: 10 }).notNull(), // first chars of `sw_xxxx` for log identification
    scopes: text("scopes").array().notNull(),
    last_used_at: timestamp("last_used_at", { withTimezone: true, mode: "string" }),
    revoked_at: timestamp("revoked_at", { withTimezone: true, mode: "string" }),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (t) => ({
    hashedUnique: uniqueIndex("api_tokens_hashed_unique").on(t.hashed_token),
    userIdx: index("api_tokens_user_idx").on(t.user_id),
  })
);

// ─── notifications (persistent @mention surface) ────────────────────────────
//
// Replaces the 3.1 live-scan with a real unread/seen state. Currently only
// `mention` kind; `assigned` and `comment_on_my_ticket` are deliberately
// out of scope per the Phase 3 plan ("My open tickets" + dashboards already
// cover those signals).
//
// Dedup is in application code rather than via a unique constraint so we
// don't have to depend on PG 15's NULLS NOT DISTINCT semantics.

export const notificationKind = pgEnum("notification_kind", ["mention"]);

export const notifications = pgTable(
  "notifications",
  {
    id: id(),
    user_id: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: notificationKind("kind").notNull(),
    actor_id: uuid("actor_id").references(() => users.id, { onDelete: "set null" }),
    ticket_id: uuid("ticket_id").references(() => tickets.id, { onDelete: "cascade" }),
    comment_id: uuid("comment_id").references(() => comments.id, { onDelete: "cascade" }),
    payload: jsonb("payload").notNull().default({}),
    read_at: timestamp("read_at", { withTimezone: true, mode: "string" }),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (t) => ({
    // Partial index — bell-badge unread-count + dropdown query both walk
    // the same prefix.
    unreadIdx: index("notifications_unread_idx")
      .on(t.user_id, t.created_at)
      .where(sql`${t.read_at} IS NULL`),
    listIdx: index("notifications_list_idx").on(t.user_id, t.created_at),
  })
);

// ─── saved_views (named filter combinations on the tickets list) ────────────
//
// Personal views are visible only to the owner; shared views are visible to
// every user. (`scope = 'shared'` is opt-in via the save dialog — default is
// 'personal'.) Filter shape mirrors the URL filter slots on /tickets so
// applying a view is a router.replace away.
//
// Uniqueness: per (owner_id, name). Two users can each have a "My queue";
// shared views still pin their owner so we know who can edit.

export const savedViewScope = pgEnum("saved_view_scope", ["personal", "shared"]);

export const savedViews = pgTable(
  "saved_views",
  {
    id: id(),
    name: varchar("name", { length: 100 }).notNull(),
    owner_id: uuid("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    scope: savedViewScope("scope").notNull().default("personal"),
    filters: jsonb("filters").notNull().default({}),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (t) => ({
    ownerNameUnique: uniqueIndex("saved_views_owner_name_unique").on(t.owner_id, t.name),
    scopeIdx: index("saved_views_scope_idx").on(t.scope),
  })
);

// ─── system_settings (singleton key/value store) ────────────────────────────
//
// Holds runtime-configurable globals — currently the stale-in-progress
// threshold used by the project stats endpoint, eventually any other admin
// knob we don't want to bake into env vars. Values are JSONB so each key
// can carry whatever shape it needs (number, string, object) without
// schema churn per setting.

export const systemSettings = pgTable("system_settings", {
  key: varchar("key", { length: 80 }).primaryKey(),
  value: jsonb("value").notNull(),
  updated_at: updatedAt(),
});

// ─── rules + rule_firings (Phase 4 native automation) ─────────────────────
//
// Rules fire async via lib/rules/dispatcher.ts (mirrors webhooks dispatcher).
// `writeEvent` enqueues a `rule_firings` row per matching rule, skipping
// rule-authored events (actor = rules-engine system user) to prevent infinite
// loops. Conditions are evaluated by the dispatcher, not at enqueue time, so
// even firings whose conditions fall false get logged with status=skipped
// for debugging.

export const ruleFiringStatus = pgEnum("rule_firing_status", [
  "pending", "running", "succeeded", "failed", "abandoned", "skipped",
]);

export const rules = pgTable(
  "rules",
  {
    id: id(),
    // NULL = global rule (matches every project), 4.1+. Project-scoped
    // rules carry the owning project's id and only fire on its events.
    project_id: uuid("project_id").references(() => projects.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 200 }).notNull(),
    enabled: boolean("enabled").notNull().default(true),
    // Empty array is invalid — at least one event type required. Enforced by
    // Zod at the API layer; no DB constraint to keep migration story simple.
    trigger_event_types: text("trigger_event_types").array().notNull(),
    // RuleConditions in shared/schemas/rule.ts. `{}` = always-true.
    conditions: jsonb("conditions").notNull().default({}),
    // Array of RuleAction (discriminated union); evaluated in order.
    actions: jsonb("actions").notNull().default([]),
    // HMAC secret used by fire_webhook / call_n8n actions. Returned ONCE
    // on POST /v1/rules; hidden from every subsequent response. Always
    // generated at rule creation (cheap; lets users add webhook actions
    // later via PATCH without re-creating the rule).
    webhook_secret: text("webhook_secret"),
    // ─── scheduled-rule columns ───────────────────────────────────────
    // Standard 5-field cron (e.g. "0 9 * * MON"). When set, the rule is
    // a scheduled rule — trigger_event_types must be empty and the
    // scheduler loop fires it on the cron cadence rather than reacting
    // to events. Mutually exclusive with trigger_event_types (CHECK).
    schedule_cron: text("schedule_cron"),
    // IANA timezone name (e.g. "America/New_York"). NULL = UTC. Lets
    // "every Monday 9am" mean local 9am for the rule author.
    schedule_tz: varchar("schedule_tz", { length: 80 }),
    // Ticket filter shape mirroring /v1/tickets query params. At fire
    // time the scheduler runs this query, enqueues one rule_firing per
    // matched ticket. See ScheduledRuleTarget in shared/schemas/rule.ts.
    target_query: jsonb("target_query"),
    last_fired_at: timestamp("last_fired_at", { withTimezone: true, mode: "string" }),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (t) => ({
    projectIdx: index("rules_project_idx").on(t.project_id),
    enabledIdx: index("rules_enabled_idx").on(t.enabled).where(sql`${t.enabled} = true`),
    // Exactly one trigger mode per rule. coalesce() handles PG's "empty
    // array length is NULL" quirk so the constraint works whether
    // trigger_event_types is '{}' or a populated array.
    triggerMode: check(
      "rules_trigger_mode_xor",
      sql`(
        (${t.schedule_cron} IS NULL AND coalesce(array_length(${t.trigger_event_types}, 1), 0) > 0)
        OR
        (${t.schedule_cron} IS NOT NULL AND coalesce(array_length(${t.trigger_event_types}, 1), 0) = 0)
      )`,
    ),
    scheduledIdx: index("rules_scheduled_idx")
      .on(t.enabled, t.schedule_cron)
      .where(sql`${t.enabled} = true AND ${t.schedule_cron} IS NOT NULL`),
  })
);

export const ruleFirings = pgTable(
  "rule_firings",
  {
    id: id(),
    rule_id: uuid("rule_id")
      .notNull()
      .references(() => rules.id, { onDelete: "cascade" }),
    // Nullable for scheduled firings (no triggering event).
    event_id: uuid("event_id").references(() => events.id, { onDelete: "cascade" }),
    // Set for scheduled firings — the ticket the actions operate on,
    // pre-matched by the rule's target_query. NULL for event-triggered
    // firings (the ticket comes from the event payload). Cascade so
    // deleted tickets don't leave orphan firings.
    ticket_id: uuid("ticket_id").references(() => tickets.id, { onDelete: "cascade" }),
    status: ruleFiringStatus("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    last_error: text("last_error"),
    last_attempt_at: timestamp("last_attempt_at", { withTimezone: true, mode: "string" }),
    next_attempt_at: timestamp("next_attempt_at", { withTimezone: true, mode: "string" }),
    // RuleFiringResultSummary in shared/schemas/rule.ts — which conditions
    // matched, per-action ok/error, optional skip reason.
    result_summary: jsonb("result_summary"),
    created_at: createdAt(),
  },
  (t) => ({
    pendingIdx: index("rule_firings_pending_idx")
      .on(t.next_attempt_at)
      .where(sql`${t.status} IN ('pending', 'failed')`),
    ruleIdx: index("rule_firings_rule_idx").on(t.rule_id, t.created_at),
  })
);

// ─── idempotency keys (request deduplication for POSTs) ─────────────────────

export const idempotencyKeys = pgTable(
  "idempotency_keys",
  {
    key: varchar("key", { length: 128 }).notNull(),
    user_id: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    method: varchar("method", { length: 10 }).notNull(),
    path: varchar("path", { length: 500 }).notNull(),
    response_status: integer("response_status").notNull(),
    response_body: jsonb("response_body").notNull(),
    created_at: createdAt(),
    // Idempotency keys are scoped per (user, method, path) and expire after 24h.
    expires_at: timestamp("expires_at", { withTimezone: true, mode: "string" }).notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.user_id, t.method, t.path, t.key] }),
    expiresIdx: index("idempotency_keys_expires_idx").on(t.expires_at),
  })
);
