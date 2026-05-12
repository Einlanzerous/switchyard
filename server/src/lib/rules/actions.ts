// Action runners for the rule engine. Each action receives the resolved
// context (event payload, rule metadata, rules-engine user id) and performs
// its side effect inside a single transaction. Events are emitted via the
// existing writeEvent helper so audit, webhook fan-out, and downstream
// rule eligibility come for free.
//
// Errors thrown from an action are caught by the dispatcher and recorded on
// the firing as action-internal failures. They do NOT auto-retry — admins
// redeliver via POST /v1/rules/firings/{id}/redeliver.

import { and, eq, isNull } from "drizzle-orm";
import * as schema from "../../../drizzle/schema.js";
import { db } from "../../db.js";
import { env } from "../../env.js";
import { writeEvent } from "../events.js";
import { loadTicketSummary } from "../tickets.js";
import { signHmac } from "../hmac.js";
import type {
  RuleAction, SetFieldAction, AddLabelAction, CommentAction,
  AssignAction, MoveStatusAction, FireWebhookAction, CallN8nAction,
  Priority, StatusCategory,
} from "@switchyard/shared";
import type { RuleContext, ActionOutcome } from "./types.js";
import { resolveFieldPath } from "./evaluator.js";

const VALID_PRIORITIES: Priority[] = ["low", "medium", "high", "critical"];
const HEX_RE = /^#[0-9a-fA-F]{6}$/;

export async function runAction(action: RuleAction, ctx: RuleContext): Promise<ActionOutcome> {
  try {
    switch (action.type) {
      case "set_field":
        await runSetField(action, ctx);
        break;
      case "add_label":
        await runAddLabel(action, ctx);
        break;
      case "comment":
        await runComment(action, ctx);
        break;
      case "assign":
        await runAssign(action, ctx);
        break;
      case "move_status":
        await runMoveStatus(action, ctx);
        break;
      case "fire_webhook":
        await runFireWebhook(action, ctx);
        break;
      case "call_n8n":
        await runCallN8n(action, ctx);
        break;
    }
    return { type: action.type, status: "ok" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { type: action.type, status: "error", error: message };
  }
}

// ─── set_field ──────────────────────────────────────────────────────────────

async function runSetField(action: SetFieldAction, ctx: RuleContext): Promise<void> {
  const ticket = requireTicket(ctx);

  await db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(schema.tickets)
      .where(eq(schema.tickets.id, ticket.id))
      .limit(1);
    if (!existing) throw new Error(`ticket ${ticket.id} not found`);

    const sets: Partial<typeof schema.tickets.$inferInsert> = {};
    const changes: Array<{ field: string; from: unknown; to: unknown }> = [];

    if (action.field === "priority") {
      const value = coercePriority(action.value);
      if (existing.priority === value) return; // no-op
      sets.priority = value;
      changes.push({ field: "priority", from: existing.priority, to: value });
    } else if (action.field === "due_date") {
      const value = coerceIso(action.value);
      if (existing.due_date === value) return;
      sets.due_date = value;
      changes.push({ field: "due_date", from: existing.due_date, to: value });
    } else if (action.field === "parent_id") {
      const value = coerceUuidOrNull(action.value);
      if (existing.parent_id === value) return;
      // Defensive: don't let a rule create a parent loop or cross-project link.
      if (value !== null) {
        const [parent] = await tx
          .select()
          .from(schema.tickets)
          .where(eq(schema.tickets.id, value))
          .limit(1);
        if (!parent) throw new Error(`parent ticket ${value} not found`);
        if (parent.project_id !== existing.project_id) {
          throw new Error("parent must be in the same project");
        }
        if (parent.type !== "epic") throw new Error("parent must be an epic");
        if (existing.type === "epic") throw new Error("epics cannot have a parent");
      }
      sets.parent_id = value;
      changes.push({ field: "parent_id", from: existing.parent_id, to: value });
    } else if (action.field.startsWith("metadata.")) {
      const key = action.field.slice("metadata.".length);
      const oldMeta = (existing.metadata ?? {}) as Record<string, unknown>;
      const oldVal = oldMeta[key];
      if (deepEqualUnknown(oldVal, action.value)) return;
      const nextMeta = { ...oldMeta, [key]: action.value };
      sets.metadata = nextMeta as any;
      changes.push({ field: `metadata.${key}`, from: oldVal, to: action.value });
    } else {
      throw new Error(`set_field: unsupported field ${action.field}`);
    }

    if (Object.keys(sets).length === 0) return;

    await tx.update(schema.tickets).set(sets).where(eq(schema.tickets.id, ticket.id));

    const refreshed = (await tx.select().from(schema.tickets).where(eq(schema.tickets.id, ticket.id)).limit(1))[0]!;
    const summary = await loadTicketSummary(refreshed, tx as any);
    await writeEvent(tx as any, {
      event_type: "ticket.updated",
      actor: ctx.rulesEngineActor,
      ticket: summary,
      project_id: refreshed.project_id,
      changes: { fields: changes },
    });
  });
}

function coercePriority(raw: unknown): Priority | null {
  if (raw === null) return null;
  if (typeof raw !== "string") throw new Error(`priority must be a string, got ${typeof raw}`);
  if (!VALID_PRIORITIES.includes(raw as Priority)) {
    throw new Error(`priority must be one of ${VALID_PRIORITIES.join("|")}`);
  }
  return raw as Priority;
}

function coerceIso(raw: unknown): string | null {
  if (raw === null) return null;
  if (typeof raw !== "string") throw new Error(`due_date must be ISO string or null`);
  // Loose validation — Date.parse handles ISO8601.
  if (Number.isNaN(Date.parse(raw))) throw new Error(`due_date is not a valid ISO timestamp`);
  return raw;
}

function coerceUuidOrNull(raw: unknown): string | null {
  if (raw === null) return null;
  if (typeof raw !== "string") throw new Error("parent_id must be uuid or null");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)) {
    throw new Error("parent_id must be a uuid");
  }
  return raw;
}

// ─── add_label ──────────────────────────────────────────────────────────────

async function runAddLabel(action: AddLabelAction, ctx: RuleContext): Promise<void> {
  const ticket = requireTicket(ctx);
  if (action.color && !HEX_RE.test(action.color)) {
    throw new Error("color must be a #RRGGBB hex");
  }

  await db.transaction(async (tx) => {
    // Ensure label exists (create if missing). Default color when omitted.
    let [label] = await tx
      .select()
      .from(schema.labels)
      .where(eq(schema.labels.name, action.label))
      .limit(1);

    if (!label) {
      const [created] = await tx
        .insert(schema.labels)
        .values({ name: action.label, color: action.color ?? "#6b7280" })
        .returning();
      if (!created) throw new Error("label insert returned nothing");
      label = created;
    }

    // Idempotent attach (composite PK on (ticket_id, label_id)).
    const [link] = await tx
      .select()
      .from(schema.ticketLabels)
      .where(and(eq(schema.ticketLabels.ticket_id, ticket.id), eq(schema.ticketLabels.label_id, label.id)))
      .limit(1);

    if (link) return; // already attached — silent no-op

    await tx.insert(schema.ticketLabels).values({ ticket_id: ticket.id, label_id: label.id });

    const refreshed = (await tx.select().from(schema.tickets).where(eq(schema.tickets.id, ticket.id)).limit(1))[0]!;
    const summary = await loadTicketSummary(refreshed, tx as any);
    await writeEvent(tx as any, {
      event_type: "ticket.updated",
      actor: ctx.rulesEngineActor,
      ticket: summary,
      project_id: refreshed.project_id,
      changes: { fields: [{ field: "labels", from: null, to: { added: label.name } }] },
    });
  });
}

// ─── comment ────────────────────────────────────────────────────────────────

async function runComment(action: CommentAction, ctx: RuleContext): Promise<void> {
  const ticket = requireTicket(ctx);
  const body = renderTemplate(action.body, ctx);

  await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(schema.comments)
      .values({
        ticket_id: ticket.id,
        author_id: ctx.rules_engine_user_id,
        body,
      })
      .returning();
    if (!created) throw new Error("comment insert returned nothing");

    const refreshed = (await tx.select().from(schema.tickets).where(eq(schema.tickets.id, ticket.id)).limit(1))[0]!;
    const summary = await loadTicketSummary(refreshed, tx as any);
    await writeEvent(tx as any, {
      event_type: "comment.created",
      actor: ctx.rulesEngineActor,
      ticket: summary,
      project_id: refreshed.project_id,
      extras: { comment_id: created.id, comment_body: created.body },
    });
  });
}

// ─── assign ─────────────────────────────────────────────────────────────────

async function runAssign(action: AssignAction, ctx: RuleContext): Promise<void> {
  const ticket = requireTicket(ctx);

  await db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(schema.tickets)
      .where(eq(schema.tickets.id, ticket.id))
      .limit(1);
    if (!existing) throw new Error(`ticket ${ticket.id} not found`);

    // Resolve target user. `null` = clear; otherwise look up by id (uuid)
    // or name. The name path lets rule authors write a stable rule that
    // doesn't break when a user's row id changes (e.g. re-seed).
    let nextAssigneeId: string | null = null;
    if (action.user !== null) {
      nextAssigneeId = await resolveUserIdentifier(tx as any, action.user);
    }

    if (existing.assignee_id === nextAssigneeId) return; // no-op

    await tx
      .update(schema.tickets)
      .set({ assignee_id: nextAssigneeId })
      .where(eq(schema.tickets.id, ticket.id));

    const refreshed = (await tx.select().from(schema.tickets).where(eq(schema.tickets.id, ticket.id)).limit(1))[0]!;
    const summary = await loadTicketSummary(refreshed, tx as any);
    await writeEvent(tx as any, {
      event_type: "ticket.assigned",
      actor: ctx.rulesEngineActor,
      ticket: summary,
      project_id: refreshed.project_id,
      changes: { fields: [{ field: "assignee_id", from: existing.assignee_id, to: nextAssigneeId }] },
    });
  });
}

async function resolveUserIdentifier(
  tx: typeof db,
  identifier: string
): Promise<string> {
  // UUID-ish? Look up by id; otherwise by (live) name.
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(identifier);
  const [user] = await tx
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(and(
      isUuid ? eq(schema.users.id, identifier) : eq(schema.users.name, identifier),
      isNull(schema.users.deleted_at),
    ))
    .limit(1);
  if (!user) throw new Error(`assign: user "${identifier}" not found`);
  return user.id;
}

// ─── move_status ────────────────────────────────────────────────────────────
//
// Mirrors the validation in routes/tickets.ts:/transition — the transitions
// whitelist (zero rows = wildcard, any rows = whitelist), epic-close guard,
// and resolution-required-when-closed rule. Emits ticket.status_changed
// always plus ticket.closed / ticket.released when appropriate.

async function runMoveStatus(action: MoveStatusAction, ctx: RuleContext): Promise<void> {
  const ticket = requireTicket(ctx);

  if (action.to_category === "closed" && !action.resolution) {
    throw new Error("move_status to closed requires a resolution");
  }

  await db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(schema.tickets)
      .where(eq(schema.tickets.id, ticket.id))
      .limit(1);
    if (!existing) throw new Error(`ticket ${ticket.id} not found`);

    // Resolve target status: prefer an exact display_name match in the
    // requested category; fall back to the project's default in that
    // category; finally any status in the category (first by position).
    const candidates = await tx
      .select()
      .from(schema.statuses)
      .where(and(
        eq(schema.statuses.project_id, existing.project_id),
        eq(schema.statuses.category, action.to_category as StatusCategory),
      ));
    if (candidates.length === 0) {
      throw new Error(
        `move_status: project has no status in category "${action.to_category}"`,
      );
    }
    const target = action.to_status
      ? candidates.find((s) => s.display_name === action.to_status)
      : candidates.find((s) => s.is_default) ?? candidates.sort((a, b) => a.position - b.position)[0];
    if (!target) {
      throw new Error(
        `move_status: no status matching to_status="${action.to_status}" in category "${action.to_category}"`,
      );
    }

    if (existing.status_id === target.id) return; // no-op

    // Transitions whitelist — same logic as /transition.
    const transitions = await tx
      .select()
      .from(schema.statusTransitions)
      .where(eq(schema.statusTransitions.project_id, existing.project_id));
    if (transitions.length > 0) {
      const allowed = transitions.some(
        (t) =>
          t.to_status_id === target.id &&
          (t.from_status_id === null || t.from_status_id === existing.status_id),
      );
      if (!allowed) {
        throw new Error(
          `move_status: transition from current status to "${target.display_name}" is not allowed`,
        );
      }
    }

    // Epic-close guard — same shape as routes/tickets.ts:/transition.
    if (existing.type === "epic" && action.to_category === "closed") {
      const children = await tx
        .select({ category: schema.statuses.category })
        .from(schema.tickets)
        .innerJoin(schema.statuses, eq(schema.statuses.id, schema.tickets.status_id))
        .where(and(
          eq(schema.tickets.parent_id, existing.id),
          isNull(schema.tickets.deleted_at),
        ));
      const openCount = children.filter((c) => c.category !== "closed").length;
      if (openCount > 0) {
        throw new Error(`move_status: cannot close epic with ${openCount} open child ticket(s)`);
      }
    }

    const prevStatusId = existing.status_id;
    const [prevStatus] = await tx
      .select()
      .from(schema.statuses)
      .where(eq(schema.statuses.id, prevStatusId))
      .limit(1);

    await tx
      .update(schema.tickets)
      .set({
        status_id: target.id,
        resolution: action.to_category === "closed" ? (action.resolution ?? null) : null,
      })
      .where(eq(schema.tickets.id, ticket.id));

    const refreshed = (await tx.select().from(schema.tickets).where(eq(schema.tickets.id, ticket.id)).limit(1))[0]!;
    const summary = await loadTicketSummary(refreshed, tx as any);

    await writeEvent(tx as any, {
      event_type: "ticket.status_changed",
      actor: ctx.rulesEngineActor,
      ticket: summary,
      project_id: refreshed.project_id,
      changes: {
        status: {
          from: prevStatus ? { id: prevStatus.id, category: prevStatus.category as any, display_name: prevStatus.display_name } : null,
          to: { id: target.id, category: target.category as any, display_name: target.display_name },
          resolution: refreshed.resolution as any,
        },
      },
    });

    if (action.to_category === "closed") {
      await writeEvent(tx as any, {
        event_type: "ticket.closed",
        actor: ctx.rulesEngineActor,
        ticket: summary,
        project_id: refreshed.project_id,
      });
      if (action.resolution === "released") {
        await writeEvent(tx as any, {
          event_type: "ticket.released",
          actor: ctx.rulesEngineActor,
          ticket: summary,
          project_id: refreshed.project_id,
        });
      }
    }
  });
}

// ─── fire_webhook / call_n8n ────────────────────────────────────────────────
//
// HMAC-signed HTTP POST. Body is the standard Event envelope from the
// triggering event payload; signing key is the rule's `webhook_secret`
// (returned ONCE on rule creation; rotation = recreate the rule). Unlike
// the webhook subscription dispatcher, action failures here do NOT get
// retried automatically — admin redelivers the firing.

async function runFireWebhook(action: FireWebhookAction, ctx: RuleContext): Promise<void> {
  // Two forms: literal URL, or named target with optional path.
  // Resolution happens at fire time so target URL/secret changes propagate
  // without rewriting the rule.
  if (action.target) {
    const target = await resolveTargetByName(action.target);
    const path = action.path ?? "";
    await deliverWebhook({
      url: target.url + path,
      method: action.method ?? "POST",
      headers: { ...(target.headers as Record<string, string> ?? {}), ...(action.headers ?? {}) },
      hmacKey: target.hmac_secret, // null = fall back to rule's webhook_secret in deliverWebhook
      ctx,
    });
    return;
  }
  if (!action.url) {
    // Zod refine already rejected this, but be defensive at runtime.
    throw new Error("fire_webhook: neither url nor target was set");
  }
  await deliverWebhook({
    url: action.url,
    method: action.method ?? "POST",
    headers: action.headers ?? {},
    ctx,
  });
}

async function resolveTargetByName(name: string): Promise<typeof schema.targets.$inferSelect> {
  const lowered = name.toLowerCase();
  const [t] = await db.select().from(schema.targets).where(eq(schema.targets.name, lowered)).limit(1);
  if (!t) throw new Error(`fire_webhook: target "${name}" not found`);
  return t;
}

async function runCallN8n(action: CallN8nAction, ctx: RuleContext): Promise<void> {
  const targetName = process.env.N8N_TARGET_NAME ?? "n8n";
  const path = action.workflow.startsWith("/") ? action.workflow : `/${action.workflow}`;

  // Prefer a named target so n8n routing benefits from the same
  // decoupling as fire_webhook. Falls back to the legacy N8N_BASE_URL
  // env so existing rules keep working during rollout.
  const [target] = await db.select().from(schema.targets)
    .where(eq(schema.targets.name, targetName.toLowerCase())).limit(1);
  if (target) {
    await deliverWebhook({
      url: target.url + path,
      method: "POST",
      headers: (target.headers as Record<string, string> ?? {}),
      hmacKey: target.hmac_secret,
      ctx,
    });
    return;
  }
  if (!env.N8N_BASE_URL) {
    throw new Error(`call_n8n: no target "${targetName}" and N8N_BASE_URL env is not set`);
  }
  await deliverWebhook({
    url: `${env.N8N_BASE_URL}${path}`,
    method: "POST",
    headers: {},
    ctx,
  });
}

async function deliverWebhook(opts: {
  url: string;
  method: "POST" | "PUT";
  headers: Record<string, string>;
  ctx: RuleContext;
  // Optional override; falls through to the rule's webhook_secret when
  // null/undefined. Set by callers that resolved a target with its own
  // hmac_secret column.
  hmacKey?: string | null;
}): Promise<void> {
  const { url, method, headers, ctx, hmacKey } = opts;

  // Choose the signing key: explicit target secret > rule webhook_secret.
  // Look up the rule's secret only when needed.
  let signingKey: string | null = hmacKey ?? null;
  if (!signingKey) {
    const [rule] = await db
      .select({ webhook_secret: schema.rules.webhook_secret })
      .from(schema.rules)
      .where(eq(schema.rules.id, ctx.rule.id))
      .limit(1);
    if (!rule?.webhook_secret) {
      throw new Error("fire_webhook: rule has no webhook_secret (recreate the rule)");
    }
    signingKey = rule.webhook_secret;
  }

  // Webhook envelope identical to subscriptions: id/event/occurred_at on
  // top of the stored payload (actor, ticket, changes, extras).
  const envelope = {
    id: ctx.event_id,
    event: ctx.event_type,
    occurred_at: new Date().toISOString(),
    ...ctx.event_payload,
  };
  const body = JSON.stringify(envelope);
  const signature = signHmac(signingKey, body);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), env.RULE_WEBHOOK_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method,
      headers: {
        ...headers,
        "Content-Type": "application/json",
        "X-Switchyard-Signature": `sha256=${signature}`,
        "X-Switchyard-Event": ctx.event_type,
        "X-Switchyard-Rule": ctx.rule.id,
        "User-Agent": "switchyard-rules/0.0.0",
      },
      body,
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`webhook ${url} → HTTP ${res.status}`);
    }
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`webhook ${url} timed out after ${env.RULE_WEBHOOK_TIMEOUT_MS}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

// ─── helpers ────────────────────────────────────────────────────────────────

type TicketRef = { id: string };

function requireTicket(ctx: RuleContext): TicketRef {
  const ticket = (ctx.event_payload.ticket ?? null) as { id?: string } | null;
  if (!ticket?.id) {
    throw new Error("action requires a ticket in the event payload");
  }
  return { id: ticket.id };
}

// `{{path}}` and `{{rule.name}}` template substitution. Missing paths render
// as empty string rather than literal `<undefined>` so a misspelled token
// doesn't pollute the comment body.
export function renderTemplate(template: string, ctx: RuleContext): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_.\[\]]+)\s*\}\}/g, (_, path: string) => {
    if (path === "rule.name") return ctx.rule.name;
    if (path === "rule.id") return ctx.rule.id;
    const value = resolveFieldPath(ctx.event_payload, path);
    if (value === undefined || value === null) return "";
    if (typeof value === "string") return value;
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  });
}

function deepEqualUnknown(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return false;
  if (typeof a !== typeof b) return false;
  if (typeof a !== "object") return false;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}
