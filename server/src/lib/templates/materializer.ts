// Materialize a ticket from a ticket_template (SWY-43 Phase 4.7).
//
// One call:
//   1. Allocates a project-scoped ticket number
//   2. Resolves the destination status (project default)
//   3. Computes due_date from the template's offset (recurring) or
//      trigger_at (one-shot)
//   4. INSERTs the ticket row with the template_id back-pointer
//   5. INSERTs ticket_labels rows for the template's label_ids
//   6. Writes a ticket.created event so audit + webhooks fire
//
// The caller wraps this in a transaction together with the
// last_fired_at stamp + enabled-flip (one-shot) so concurrent ticks
// can't double-materialize.

import { and, eq, isNull, ne, sql } from "drizzle-orm";
import * as schema from "../../../drizzle/schema.js";
import type { db as defaultDb } from "../../db.js";
import { allocateTicketNumber } from "../tickets.js";
import { writeEvent } from "../events.js";
import { mapTicketSummary, mapUserRef } from "../mappers.js";

type Tx = typeof defaultDb;
type TemplateRow = typeof schema.ticketTemplates.$inferSelect;
type TicketRow = typeof schema.tickets.$inferSelect;

// One day in milliseconds — used to convert `due_date_offset_days` into
// a date offset from the fire timestamp.
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export type MaterializeResult =
  | { kind: "created"; ticket: TicketRow }
  | { kind: "skipped"; reason: "overlap_skip" }
  | { kind: "reused"; ticket: TicketRow };

// Returns the inserted ticket row (or null when overlap_policy=skip and
// an open instance already exists). Reuse-open semantics: bump the open
// instance's due_date and return it without creating a new one.
export async function materializeFromTemplate(
  tx: Tx,
  template: TemplateRow,
  firedAt: Date,
): Promise<MaterializeResult> {
  // ─── overlap policy ─────────────────────────────────────────────────────
  if (template.overlap_policy === "skip" || template.overlap_policy === "reuse_open") {
    const open = await tx
      .select({ t: schema.tickets, s: schema.statuses })
      .from(schema.tickets)
      .innerJoin(schema.statuses, eq(schema.tickets.status_id, schema.statuses.id))
      .where(
        and(
          eq(schema.tickets.template_id, template.id),
          isNull(schema.tickets.deleted_at),
          ne(schema.statuses.category, "closed"),
        ),
      )
      .limit(1);

    if (open.length > 0) {
      if (template.overlap_policy === "skip") {
        return { kind: "skipped", reason: "overlap_skip" };
      }
      // reuse_open: bump the open instance's due_date to the new
      // computed value. Common case: recurring task that nobody's
      // closed yet — push the deadline forward instead of stacking.
      const newDue = computeDueDate(template, firedAt);
      const [bumped] = await tx
        .update(schema.tickets)
        .set({ due_date: newDue, updated_at: new Date().toISOString() })
        .where(eq(schema.tickets.id, open[0]!.t.id))
        .returning();
      return { kind: "reused", ticket: bumped! };
    }
  }

  // ─── resolve destination status (project default) ───────────────────────
  const [def] = await tx
    .select({ id: schema.statuses.id })
    .from(schema.statuses)
    .where(
      and(
        eq(schema.statuses.project_id, template.project_id),
        eq(schema.statuses.is_default, true),
      ),
    )
    .limit(1);
  if (!def) {
    throw new Error(
      `template ${template.id}: project has no default status — cannot materialize`,
    );
  }

  // ─── insert ticket ──────────────────────────────────────────────────────
  const number = await allocateTicketNumber(tx, template.project_id);
  const dueDate = computeDueDate(template, firedAt);

  const [t] = await tx
    .insert(schema.tickets)
    .values({
      project_id: template.project_id,
      number,
      type: template.type,
      title: template.title,
      description: template.description,
      status_id: def.id,
      priority: template.priority,
      parent_id: template.parent_id,
      assignee_id: template.assignee_id,
      reporter_id: template.created_by_user_id,
      due_date: dueDate,
      position: Date.now(),
      metadata: (template.metadata ?? {}) as any,
      template_id: template.id,
    })
    .returning();
  if (!t) throw new Error("template materializer: insert returned nothing");

  // ─── labels ─────────────────────────────────────────────────────────────
  const labelIds = (template.label_ids ?? []) as string[];
  if (labelIds.length > 0) {
    await tx
      .insert(schema.ticketLabels)
      .values(labelIds.map((label_id) => ({ ticket_id: t.id, label_id })))
      .onConflictDoNothing();
  }

  // ─── audit + webhook fan-out via the standard event path ────────────────
  const [project] = await tx
    .select()
    .from(schema.projects)
    .where(eq(schema.projects.id, template.project_id))
    .limit(1);
  const [creator] = await tx
    .select()
    .from(schema.users)
    .where(eq(schema.users.id, template.created_by_user_id))
    .limit(1);
  const [status] = await tx
    .select()
    .from(schema.statuses)
    .where(eq(schema.statuses.id, def.id))
    .limit(1);

  if (project && creator && status) {
    const summary = mapTicketSummary(t, {
      project,
      status,
      assignee: null,
      reporter: creator,
      labels: [],
      number: t.number,
      externalRefs: [],
    });
    await writeEvent(tx, {
      event_type: "ticket.created",
      actor: mapUserRef(creator),
      ticket: summary,
      project_id: project.id,
      extras: { source: "ticket_template", template_id: template.id },
    });
  }

  return { kind: "created", ticket: t };
}

// Compute the new instance's due_date.
//   - One-shot: the template's `trigger_at` is the literal due date.
//   - Recurring with offset: firedAt + offset_days.
//   - Recurring without offset: null (no due date on the instance).
function computeDueDate(template: TemplateRow, firedAt: Date): string | null {
  if (template.trigger_at) return template.trigger_at;
  if (template.due_date_offset_days == null) return null;
  const ms = firedAt.getTime() + template.due_date_offset_days * MS_PER_DAY;
  return new Date(ms).toISOString();
}

// Re-export sql shim so the route file can compose ad-hoc fragments
// without re-importing drizzle directly.
export { sql };
