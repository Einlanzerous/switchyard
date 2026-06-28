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
// Instance-wide role (Phase 6). `owner` = full instance admin (magos);
// `member` = a regular human scoped to the projects they belong to via
// `user_projects`. Agents bypass membership regardless of this value
// (see `hasInstanceWideAccess` in lib/authz.ts).
export const instanceRole = pgEnum("instance_role", ["owner", "member"]);
// Per-project role (Phase 6), carried on `user_projects.role`. `viewer` =
// read-only; `editor` = ticket/comment writes; `admin` = project config.
export const projectMemberRole = pgEnum("project_member_role", ["admin", "editor", "viewer"]);
export const statusCategory = pgEnum("status_category", [
  "backlog",
  "planning",
  "in_progress",
  "blocked",
  "closed",
]);
export const resolution = pgEnum("resolution", ["done", "released", "cancelled"]);
export const ticketType = pgEnum("ticket_type", ["spike", "task", "bug", "epic", "subtask"]);
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

// Overlap policy controls what happens when a scheduled fire would create
// a new instance while a prior instance is still open. `skip` is the safe
// default; `always` is the "weekly notes" pattern (each cycle is its own
// thing); `reuse_open` bumps the open instance's due_date forward instead
// of stacking a second one.
export const ticketTemplateOverlapPolicy = pgEnum("ticket_template_overlap_policy", [
  "skip",
  "always",
  "reuse_open",
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
    instance_role: instanceRole("instance_role").notNull().default("member"),
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
    // Canonical repo URL for the project (e.g. https://github.com/owner/repo).
    // When set, the project header renders the project name as a link out.
    // Loose `text` so we accept any URL shape; the UI validates.
    repo_url: text("repo_url"),
    // Default shell command pipeline-driven projects run for tickets that
    // don't carry their own `metadata.test_cmd`. Loose `text` — the
    // cogitation engine accepts any shell string.
    default_test_cmd: text("default_test_cmd"),
    archived_at: timestamp("archived_at", { withTimezone: true, mode: "string" }),
    // Per-project override for the kanban Closed column window. NULL
    // means inherit the system setting (`board_closed_window_days`).
    // Constrained to {7, 14, 30} at the API layer and via a CHECK so
    // an admin can't accidentally set unbounded values.
    board_closed_window_days: integer("board_closed_window_days"),
    created_at: createdAt(),
    updated_at: updatedAt(),
    deleted_at: deletedAt(),
  },
  (t) => ({
    keyUnique: uniqueIndex("projects_key_unique").on(t.key),
    keyShape: check("projects_key_shape", sql`${t.key} ~ '^[A-Z][A-Z0-9]{1,9}$'`),
    closedWindowShape: check(
      "projects_closed_window_shape",
      sql`${t.board_closed_window_days} IS NULL OR ${t.board_closed_window_days} IN (7, 14, 30)`,
    ),
  })
);

// Project membership (Phase 6). A `member`-role human sees only the projects
// they have a row here for; `role` caps what they can do within each. Owners
// and agents bypass this table entirely (see lib/authz.ts). The composite PK
// (user_id, project_id) both enforces one-row-per-pair and indexes the
// user_id-prefix lookups `visibleProjectIds` does.
export const userProjects = pgTable(
  "user_projects",
  {
    user_id: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    project_id: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    role: projectMemberRole("role").notNull(),
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

// ─── custom fields (typed views over metadata JSONB) ───────────────────────
//
// A custom_fields row declares that `metadata.<key>` on tickets in a given
// project (or globally, when project_id is null) should be surfaced as a
// typed input/display + filterable. The underlying storage is still the
// metadata jsonb column on tickets — defining a field doesn't migrate
// existing data; deleting a field doesn't drop any data either.

export const customFieldType = pgEnum("custom_field_type", [
  "text", "number", "boolean", "url", "select",
]);

export const customFields = pgTable(
  "custom_fields",
  {
    id: id(),
    // NULL = global (applies to every project). Project-scoped fields
    // shadow a same-keyed global field for tickets in that project.
    project_id: uuid("project_id").references(() => projects.id, { onDelete: "cascade" }),
    // Identifier matched against `metadata.<key>`. lowercase + digits +
    // underscores; must start with a letter.
    key: varchar("key", { length: 80 }).notNull(),
    label: varchar("label", { length: 200 }).notNull(),
    type: customFieldType("type").notNull(),
    // For type=select, `{ values: ["high","medium","low"] }`. Null for
    // every other type. Validated at the API layer (Zod superRefine).
    options: jsonb("options"),
    show_on_card: boolean("show_on_card").notNull().default(false),
    show_on_create_form: boolean("show_on_create_form").notNull().default(false),
    show_on_filter_bar: boolean("show_on_filter_bar").notNull().default(false),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (t) => ({
    // Split into two partial indexes — postgres treats NULL as distinct
    // for uniqueness, so a single (project_id, key) index would allow
    // duplicate global rows with the same key. PG 15+ has NULLS NOT
    // DISTINCT but we don't want to depend on it.
    projectKeyUnique: uniqueIndex("custom_fields_project_key_unique")
      .on(t.project_id, t.key)
      .where(sql`${t.project_id} IS NOT NULL`),
    globalKeyUnique: uniqueIndex("custom_fields_global_key_unique")
      .on(t.key)
      .where(sql`${t.project_id} IS NULL`),
    keyShape: check(
      "custom_fields_key_shape",
      sql`${t.key} ~ '^[a-z][a-z0-9_]*$'`,
    ),
    projectIdx: index("custom_fields_project_idx").on(t.project_id),
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
    // Back-pointer to the ticket_template that materialized this ticket.
    // NULL = hand-created. The template is the source of truth for FUTURE
    // instances; editing the template never touches past instances.
    template_id: uuid("template_id").references((): any => ticketTemplates.id, { onDelete: "set null" }),
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
    templateIdx: index("tickets_template_idx").on(t.template_id).where(sql`${t.template_id} IS NOT NULL`),
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

// ─── ticket external refs (links to GitHub PRs / issues / commits / Actions) ─
//
// First-class display of external state on tickets. 4.5.2 lands manual
// attach + state polling; 4.5.3 (separate ticket) adds the github-side
// webhook receiver for push-mode updates + auto-detect from PR title /
// branch convention.

export const externalRefKind = pgEnum("external_ref_kind", [
  "github_pr", "github_issue", "github_commit", "github_action", "generic",
]);

export const externalRefState = pgEnum("external_ref_state", [
  "open", "closed", "merged", "success", "failed",
]);

export const ticketExternalRefs = pgTable(
  "ticket_external_refs",
  {
    id: id(),
    ticket_id: uuid("ticket_id")
      .notNull()
      .references(() => tickets.id, { onDelete: "cascade" }),
    kind: externalRefKind("kind").notNull(),
    url: text("url").notNull(),
    // Null = state unknown (e.g. polling disabled, kind=generic, or
    // never polled yet). UI renders as a neutral chip.
    state: externalRefState("state"),
    title: text("title"),
    polled_at: timestamp("polled_at", { withTimezone: true, mode: "string" }),
    // Stamped when the poller detects a state transition vs the prior
    // polled value. Lets event consumers gate on "this just changed"
    // rather than "this was last polled".
    polled_state_changed_at: timestamp("polled_state_changed_at", { withTimezone: true, mode: "string" }),
    created_at: createdAt(),
    created_by: uuid("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
  },
  (t) => ({
    // Same URL can't be attached twice to one ticket. Different tickets
    // CAN reference the same URL (one PR fixes multiple linked tickets).
    urlUnique: uniqueIndex("ticket_external_refs_url_unique").on(t.ticket_id, t.url),
    ticketIdx: index("ticket_external_refs_ticket_idx").on(t.ticket_id),
    // Polling loop reads stale rows oldest-first; `generic` has no
    // pollable provider so it's excluded from the partial index.
    polledIdx: index("ticket_external_refs_polled_idx")
      .on(t.polled_at)
      .where(sql`${t.kind} <> 'generic'`),
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
    // Plan threads (Phase 7). When set, the comment is anchored to a plan
    // revision; `plan_anchor` pins it to a sub-target within that revision
    // (`criterion:<id>` | `section:<name>` | `plan`). Both NULL = an ordinary
    // ticket comment. FK cascades so deleting a revision drops its threads.
    plan_revision_id: uuid("plan_revision_id").references(() => planRevisions.id, {
      onDelete: "cascade",
    }),
    plan_anchor: text("plan_anchor"),
    created_at: createdAt(),
    updated_at: updatedAt(),
    deleted_at: deletedAt(),
  },
  (t) => ({
    ticketIdx: index("comments_ticket_idx").on(t.ticket_id, t.created_at),
    planRevisionIdx: index("comments_plan_revision_idx").on(t.plan_revision_id),
    // An anchor only means something attached to a revision.
    planAnchorRequiresRevision: check(
      "comments_plan_anchor_requires_revision",
      sql`${t.plan_anchor} IS NULL OR ${t.plan_revision_id} IS NOT NULL`
    ),
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

export const boards = pgTable(
  "boards",
  {
    id: id(),
    name: varchar("name", { length: 200 }).notNull(),
    layout: boardLayout("layout").notNull().default("kanban"),
    filter: jsonb("filter").notNull().default({}),
    // When true, this board's project list is auto-managed: the server
    // adds every new project on create and removes archived ones, so the
    // user always sees a "view everything" board. At most one board can
    // have this set (partial unique index below). Flipped to false when
    // the user manually edits projects via the Edit Board dialog — once
    // you touch it, you own it.
    auto_include_all_projects: boolean("auto_include_all_projects").notNull().default(false),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (t) => ({
    // Enforce at most one auto-include board at a time.
    autoIncludeUniqueIdx: uniqueIndex("boards_auto_include_unique_idx")
      .on(t.auto_include_all_projects)
      .where(sql`${t.auto_include_all_projects} = true`),
  })
);

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

// `dashboard` tokens are read-only by construction (scopes capped to the
// read-only bundle at creation — see shared READ_ONLY_SCOPES); `agent` is
// descriptive-only (agent-ness derives from users.type). Default `personal`.
export const tokenKind = pgEnum("token_kind", ["personal", "agent", "dashboard"]);

export const apiTokens = pgTable(
  "api_tokens",
  {
    id: id(),
    user_id: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 100 }).notNull(),
    kind: tokenKind("kind").notNull().default("personal"),
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

// One row per recurring or one-shot ticket template. Recurring templates
// are tz-aware cron schedules; one-shot templates fire once at
// `trigger_at - lead_days` then flip enabled=false. XOR constraint at the
// DB layer guarantees exactly one schedule mode.
//
// Materialization: when the scheduler decides a template is due, it INSERTs
// a regular ticket copying every template field, sets `tickets.template_id`
// to point back here, applies `due_date_offset_days` (recurring) or
// `trigger_at` (one-shot) to the new ticket's due_date, and stamps
// `last_fired_at` BEFORE the insert so concurrent ticks can't double-fire.
//
// Editing a template never modifies past instances — only future creates.
export const ticketTemplates = pgTable(
  "ticket_templates",
  {
    id: id(),
    project_id: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    enabled: boolean("enabled").notNull().default(true),
    // ─── template fields (copied into each instance) ──────────────────────
    title: varchar("title", { length: 500 }).notNull(),
    description: text("description").notNull().default(""),
    type: ticketType("type").notNull().default("task"),
    priority: priority("priority"),
    assignee_id: uuid("assignee_id").references(() => users.id, { onDelete: "set null" }),
    // Parent inheritance: if set, every instance is created with this
    // parent_id. NULL = each instance stands alone.
    parent_id: uuid("parent_id").references(() => tickets.id, { onDelete: "set null" }),
    // Label IDs to attach to each instance. Stored as uuid[] (small set,
    // no need for a join table here — kept inline keeps INSERTs atomic).
    label_ids: uuid("label_ids").array().notNull().default(sql`'{}'::uuid[]`),
    // Custom-field defaults copied verbatim into the new ticket's metadata.
    metadata: jsonb("metadata").notNull().default({}),
    // Days added to the fire timestamp to compute the instance's due_date.
    // NULL = no due date on instances. Recurring + non-null is the
    // common "due Friday" pattern. One-shot ignores this (its due_date
    // is `trigger_at` directly).
    due_date_offset_days: integer("due_date_offset_days"),
    // ─── schedule (XOR — recurring OR one-shot) ───────────────────────────
    // Standard 5-field cron. When set, this is a recurring template.
    schedule_cron: text("schedule_cron"),
    // IANA tz name (e.g. "America/Chicago"). NULL = UTC. Recurring only.
    schedule_tz: varchar("schedule_tz", { length: 80 }),
    // One-shot trigger date. When set, fires once at `trigger_at - lead_days`
    // and then `enabled` is flipped false. Mutually exclusive with cron.
    trigger_at: timestamp("trigger_at", { withTimezone: true, mode: "string" }),
    // Lead time before `trigger_at`. 0 = fire on the date itself.
    lead_days: integer("lead_days").notNull().default(0),
    // ─── behavior ─────────────────────────────────────────────────────────
    overlap_policy: ticketTemplateOverlapPolicy("overlap_policy").notNull().default("skip"),
    // The user who created the template. Used as reporter on each
    // materialized instance so the audit trail attributes ticket creation
    // to someone real instead of an anonymous scheduler tick.
    created_by_user_id: uuid("created_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    // ─── bookkeeping ──────────────────────────────────────────────────────
    last_fired_at: timestamp("last_fired_at", { withTimezone: true, mode: "string" }),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (t) => ({
    projectIdx: index("ticket_templates_project_idx").on(t.project_id),
    enabledIdx: index("ticket_templates_enabled_idx").on(t.enabled).where(sql`${t.enabled} = true`),
    // Schedule mode XOR — recurring OR one-shot, never both, never neither.
    scheduleMode: check(
      "ticket_templates_schedule_mode_xor",
      sql`(
        (${t.schedule_cron} IS NOT NULL AND ${t.trigger_at} IS NULL)
        OR
        (${t.schedule_cron} IS NULL AND ${t.trigger_at} IS NOT NULL)
      )`,
    ),
    // Active recurring templates the scheduler tick narrows on each pass.
    scheduledIdx: index("ticket_templates_scheduled_idx")
      .on(t.enabled, t.schedule_cron)
      .where(sql`${t.enabled} = true AND ${t.schedule_cron} IS NOT NULL`),
    // Active one-shot templates the scheduler tick narrows on each pass.
    triggerIdx: index("ticket_templates_trigger_idx")
      .on(t.enabled, t.trigger_at)
      .where(sql`${t.enabled} = true AND ${t.trigger_at} IS NOT NULL`),
  })
);

// Ticket key aliases. When a ticket moves between projects (SWY-50) its
// key changes (LOOP-3 → SWY-72). We keep the old key resolvable forever
// so external systems (n8n payloads, GitHub PR titles, agent state) that
// cached the old reference keep working. resolveTicket() falls back to
// this table on miss. Tiny table, no maintenance.
export const ticketAliases = pgTable(
  "ticket_aliases",
  {
    alias_key: varchar("alias_key", { length: 64 }).primaryKey(),
    ticket_id: uuid("ticket_id")
      .notNull()
      .references(() => tickets.id, { onDelete: "cascade" }),
    created_at: createdAt(),
  },
  (t) => ({
    ticketIdx: index("ticket_aliases_ticket_idx").on(t.ticket_id),
  })
);

// ─── LLM observability (SWY-48 / Phase 5.1) ─────────────────────────────────
// Raw per-call LLM observations emitted by every pipeline service (n8n-
// cogitation, servo-signal, autosavant-bot). Cost is NOT stored — see the
// llm_observations_with_cost view in triggers.sql, which joins to
// model_pricing at query time so we never need to backfill on price changes.

export const llmObservations = pgTable(
  "llm_observations",
  {
    id: id(),
    occurred_at: timestamp("occurred_at", { withTimezone: true, mode: "string" }).notNull(),
    actor_id: uuid("actor_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    // Nullable: ambient ops (Scribe routing decisions) happen before a ticket
    // exists. UI groups these as "Ambient" in the cost leaderboard.
    ticket_id: uuid("ticket_id").references(() => tickets.id, { onDelete: "set null" }),
    service: varchar("service", { length: 64 }).notNull(),
    operation: varchar("operation", { length: 64 }).notNull(),
    model: varchar("model", { length: 128 }).notNull(),
    provider: varchar("provider", { length: 64 }).notNull(),
    input_tokens: integer("input_tokens").notNull(),
    output_tokens: integer("output_tokens").notNull(),
    cache_creation_input_tokens: integer("cache_creation_input_tokens"),
    cache_read_input_tokens: integer("cache_read_input_tokens"),
    latency_ms: integer("latency_ms").notNull(),
    error_code: varchar("error_code", { length: 64 }),
    // Per-observation natural key for at-most-once writes. Partial unique
    // index where not null lets emitters retry partial batches safely.
    // Suggested shape: `<service>:<execution_id>:<node_or_op>:<turn>`.
    dedup_key: varchar("dedup_key", { length: 256 }),
    metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
    created_at: createdAt(),
  },
  (t) => ({
    occurredAtIdx: index("llm_observations_occurred_at_idx").on(sql`${t.occurred_at} DESC`),
    // Composite for per-ticket cost decomposition + HITL stall detector's
    // "max(occurred_at) WHERE ticket_id = X" absence-of-data query.
    ticketIdx: index("llm_observations_ticket_idx").on(t.ticket_id, sql`${t.occurred_at} DESC`),
    serviceOpIdx: index("llm_observations_service_op_idx").on(
      t.service,
      t.operation,
      t.occurred_at,
    ),
    actorIdx: index("llm_observations_actor_idx").on(t.actor_id, t.occurred_at),
    // Unique on dedup_key — lets the route use INSERT ... ON CONFLICT
    // (dedup_key) DO NOTHING. Postgres treats NULL as distinct in unique
    // indexes by default, so observations without a dedup_key (NULL) don't
    // collide with each other — equivalent to a partial unique WHERE NOT
    // NULL, but inference-friendly for ON CONFLICT (which requires the
    // arbiter index predicate to match exactly).
    dedupKeyUnique: uniqueIndex("llm_observations_dedup_key_unique").on(t.dedup_key),
    tokensNonNeg: check(
      "llm_observations_tokens_non_negative",
      sql`${t.input_tokens} >= 0 AND ${t.output_tokens} >= 0 AND ${t.latency_ms} >= 0`,
    ),
  }),
);

// Pricing table consumed by the llm_observations_with_cost view. Periods
// must not overlap for (model, provider) — a tstzrange exclusion constraint
// in triggers.sql enforces that. effective_to NULL = currently in effect.
export const modelPricing = pgTable(
  "model_pricing",
  {
    id: id(),
    model: varchar("model", { length: 128 }).notNull(),
    provider: varchar("provider", { length: 64 }).notNull(),
    input_usd_per_mtok: doublePrecision("input_usd_per_mtok").notNull(),
    output_usd_per_mtok: doublePrecision("output_usd_per_mtok").notNull(),
    // Multipliers applied to input_usd_per_mtok for cache reads/writes.
    // Anthropic: cache create = 1.25x input, cache read = 0.1x input.
    // Providers without prompt caching: leave both as 1.0 (or 0.0 to ignore).
    cache_creation_multiplier: doublePrecision("cache_creation_multiplier")
      .notNull()
      .default(1.0),
    cache_read_multiplier: doublePrecision("cache_read_multiplier").notNull().default(0.1),
    // Energy-priced models (local Ollama inference) carry watts instead of
    // token rates: cost = (watts/1000) × (latency_ms/3.6e6) × llm_obs_usd_per_kwh.
    // NULL = token-priced (API providers). The cost view in triggers.sql
    // branches on this; a measured `metadata.energy_wh` wins over the average.
    avg_power_watts: doublePrecision("avg_power_watts"),
    effective_from: timestamp("effective_from", { withTimezone: true, mode: "string" }).notNull(),
    effective_to: timestamp("effective_to", { withTimezone: true, mode: "string" }),
    notes: text("notes"),
    created_at: createdAt(),
  },
  (t) => ({
    modelProviderIdx: index("model_pricing_model_provider_idx").on(t.model, t.provider),
    nonNegRates: check(
      "model_pricing_non_negative",
      sql`${t.input_usd_per_mtok} >= 0 AND ${t.output_usd_per_mtok} >= 0 AND ${t.cache_creation_multiplier} >= 0 AND ${t.cache_read_multiplier} >= 0 AND (${t.avg_power_watts} IS NULL OR ${t.avg_power_watts} >= 0)`,
    ),
  }),
);

// Hourly-rolled aggregates that drive the global Insights → LLM tab tiles.
// Cost is frozen at rollup time (computed via the cost view, persisted here)
// so price changes don't retroactively rewrite history. Daily rollups
// persist forever; raw rows age out at llm_obs_retention_days.
export const llmObservationsDaily = pgTable(
  "llm_observations_daily",
  {
    id: id(),
    // Truncated to the day in UTC. The rollup job runs hourly and updates
    // "today's" row in place via ON CONFLICT.
    bucket_date: timestamp("bucket_date", { withTimezone: true, mode: "string" }).notNull(),
    service: varchar("service", { length: 64 }).notNull(),
    operation: varchar("operation", { length: 64 }).notNull(),
    model: varchar("model", { length: 128 }).notNull(),
    provider: varchar("provider", { length: 64 }).notNull(),
    // Nullable for cross-actor or cross-ticket rollups; we rollup at the
    // full-dimension grain so the UI can filter/group on any of them.
    actor_id: uuid("actor_id").references(() => users.id, { onDelete: "set null" }),
    ticket_id: uuid("ticket_id").references(() => tickets.id, { onDelete: "set null" }),
    call_count: integer("call_count").notNull(),
    input_tokens: bigint("input_tokens", { mode: "number" }).notNull(),
    output_tokens: bigint("output_tokens", { mode: "number" }).notNull(),
    cache_creation_tokens: bigint("cache_creation_tokens", { mode: "number" }).notNull(),
    cache_read_tokens: bigint("cache_read_tokens", { mode: "number" }).notNull(),
    sum_latency_ms: bigint("sum_latency_ms", { mode: "number" }).notNull(),
    p50_latency_ms: integer("p50_latency_ms").notNull(),
    p95_latency_ms: integer("p95_latency_ms").notNull(),
    p99_latency_ms: integer("p99_latency_ms").notNull(),
    cost_usd_at_rollup: doublePrecision("cost_usd_at_rollup").notNull(),
    error_count: integer("error_count").notNull(),
    rolled_up_at: timestamp("rolled_up_at", { withTimezone: true, mode: "string" })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    // Upsert key: one row per full dimension tuple per day.
    bucketDimsUnique: uniqueIndex("llm_observations_daily_bucket_dims_unique").on(
      t.bucket_date,
      t.service,
      t.operation,
      t.model,
      t.provider,
      t.actor_id,
      t.ticket_id,
    ),
    bucketIdx: index("llm_observations_daily_bucket_idx").on(sql`${t.bucket_date} DESC`),
    ticketIdx: index("llm_observations_daily_ticket_idx").on(t.ticket_id, t.bucket_date),
  }),
);

// Warn-list capture: dimension values seen in incoming observations that
// aren't in system_settings.llm_obs_known_values. Surfaced in Admin →
// Observability (5.1.2) with one-click promote (add to known_values) or
// reject (future writes 422). Until then, capture only — endpoint still
// writes the raw observation.
export const llmObsPendingValues = pgTable(
  "llm_obs_pending_values",
  {
    id: id(),
    // "service" / "operation" / "model" / "provider"
    dimension: varchar("dimension", { length: 32 }).notNull(),
    value: varchar("value", { length: 128 }).notNull(),
    first_seen_at: timestamp("first_seen_at", { withTimezone: true, mode: "string" })
      .notNull()
      .default(sql`now()`),
    last_seen_at: timestamp("last_seen_at", { withTimezone: true, mode: "string" })
      .notNull()
      .default(sql`now()`),
    observation_count: integer("observation_count").notNull().default(0),
    // Set when an admin promotes (added to known_values) or rejects (future
    // writes with this value return 422). NULL = pending review.
    resolved_at: timestamp("resolved_at", { withTimezone: true, mode: "string" }),
    resolution: varchar("resolution", { length: 16 }), // "promoted" | "rejected"
  },
  (t) => ({
    dimValueUnique: uniqueIndex("llm_obs_pending_values_dim_value_unique").on(
      t.dimension,
      t.value,
    ),
    unresolvedIdx: index("llm_obs_pending_values_unresolved_idx")
      .on(t.dimension, t.last_seen_at)
      .where(sql`${t.resolved_at} IS NULL`),
  }),
);

// ─── plans (Phase 7 — Plan-as-PR) ───────────────────────────────────────────
// One plan per ticket, many versioned revisions. A revision carries the
// narrative markdown + a checkable acceptance-criteria list; a review records
// the reviewer's per-criterion + overall verdict. Modeled on the rules /
// rule_firings family (parent entity + append-only child rows + a state
// machine). The `updated_at` auto-bump trigger (triggers.sql) applies to
// `plans` automatically; the child tables are append-or-verdict-mutated and
// intentionally carry no updated_at.

export const planStatus = pgEnum("plan_status", [
  "draft",
  "in_review",
  "changes_requested",
  "approved",
  "superseded",
]);
// Per-revision lifecycle. A submitted revision is `in_review`; a review moves
// it to approved / changes_requested / rejected. (`rejected` = reviewer judged
// the approach wrong, not just nits — drives the distinct plan.rejected event.)
export const planRevisionStatus = pgEnum("plan_revision_status", [
  "in_review",
  "changes_requested",
  "approved",
  "rejected",
]);
export const planCriterionVerdict = pgEnum("plan_criterion_verdict", [
  "pending",
  "approved",
  "rejected",
]);
export const planReviewVerdict = pgEnum("plan_review_verdict", [
  "approved",
  "changes_requested",
  "rejected",
]);

export const plans = pgTable(
  "plans",
  {
    id: id(),
    ticket_id: uuid("ticket_id")
      .notNull()
      .unique()
      .references(() => tickets.id, { onDelete: "cascade" }),
    status: planStatus("status").notNull().default("in_review"),
    // Soft reference to plan_revisions.id (deliberately NO foreign key):
    // plans <-> plan_revisions are mutually referential, so a hard FK would be
    // circular. Set right after the first revision is inserted; repointed on
    // each revise. Application code keeps it consistent.
    current_revision_id: uuid("current_revision_id"),
    revision_count: integer("revision_count").notNull().default(0),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (t) => ({
    ticketIdx: index("plans_ticket_idx").on(t.ticket_id),
  })
);

export const planRevisions = pgTable(
  "plan_revisions",
  {
    id: id(),
    plan_id: uuid("plan_id")
      .notNull()
      .references(() => plans.id, { onDelete: "cascade" }),
    rev_number: integer("rev_number").notNull(),
    narrative_md: text("narrative_md").notNull(),
    status: planRevisionStatus("status").notNull().default("in_review"),
    submitted_by: uuid("submitted_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    submitted_at: timestamp("submitted_at", { withTimezone: true, mode: "string" })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    planRevUnique: uniqueIndex("plan_revisions_plan_rev_unique").on(t.plan_id, t.rev_number),
    planIdx: index("plan_revisions_plan_idx").on(t.plan_id, t.rev_number),
  })
);

export const planCriteria = pgTable(
  "plan_criteria",
  {
    id: id(),
    revision_id: uuid("revision_id")
      .notNull()
      .references(() => planRevisions.id, { onDelete: "cascade" }),
    // The full criteria list is re-inserted on each revision (no stable keys
    // across revisions in v1; the diff is computed render-time from text).
    position: integer("position").notNull(),
    text: text("text").notNull(),
    verdict: planCriterionVerdict("verdict").notNull().default("pending"),
    reviewer_note: text("reviewer_note"),
  },
  (t) => ({
    revisionIdx: index("plan_criteria_revision_idx").on(t.revision_id, t.position),
  })
);

export const planReviews = pgTable(
  "plan_reviews",
  {
    id: id(),
    revision_id: uuid("revision_id")
      .notNull()
      .references(() => planRevisions.id, { onDelete: "cascade" }),
    reviewer_id: uuid("reviewer_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    verdict: planReviewVerdict("verdict").notNull(),
    note: text("note"),
    created_at: createdAt(),
  },
  (t) => ({
    revisionIdx: index("plan_reviews_revision_idx").on(t.revision_id, t.created_at),
  })
);
