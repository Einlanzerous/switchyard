// Action runners for the rule engine. Each action receives the resolved
// context (event payload, rule metadata, rules-engine user id) and performs
// its side effect inside a single transaction. Events are emitted via the
// existing writeEvent helper so audit, webhook fan-out, and downstream
// rule eligibility come for free.
//
// Errors thrown from an action are caught by the dispatcher and recorded on
// the firing as action-internal failures. They do NOT auto-retry — admins
// redeliver via POST /v1/rules/firings/{id}/redeliver.

import { and, eq } from "drizzle-orm";
import * as schema from "../../../drizzle/schema.js";
import { db } from "../../db.js";
import { writeEvent } from "../events.js";
import { loadTicketSummary } from "../tickets.js";
import type {
  RuleAction, SetFieldAction, AddLabelAction, CommentAction, Priority,
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
