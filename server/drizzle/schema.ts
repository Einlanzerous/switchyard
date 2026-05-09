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

export const labels = pgTable(
  "labels",
  {
    id: id(),
    project_id: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 50 }).notNull(),
    color: varchar("color", { length: 7 }).notNull(),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (t) => ({
    nameUnique: uniqueIndex("labels_project_name_unique").on(t.project_id, t.name),
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

// ─── webhooks ───────────────────────────────────────────────────────────────

export const webhookSubscriptions = pgTable(
  "webhook_subscriptions",
  {
    id: id(),
    url: text("url").notNull(),
    event_types: text("event_types").array().notNull(),
    status_filter: jsonb("status_filter"),
    secret: text("secret").notNull(),
    active: boolean("active").notNull().default(true),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (t) => ({
    activeIdx: index("webhook_subscriptions_active_idx").on(t.active),
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
