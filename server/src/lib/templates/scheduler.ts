// Ticket-template scheduler tick. Called from the rules scheduler's
// 60s loop. Polls enabled templates, computes next-fire from cron+tz
// (recurring) or `trigger_at - lead_days` (one-shot), materializes a
// ticket via the materializer when due, and stamps last_fired_at
// BEFORE the materialize so concurrent ticks can't double-fire.

import { and, eq, isNotNull, isNull, lte } from "drizzle-orm";
import { CronExpressionParser } from "cron-parser";
import * as schema from "../../../drizzle/schema.js";
import { db } from "../../db.js";
import { materializeFromTemplate } from "./materializer.js";

const MS_PER_DAY = 24 * 60 * 60 * 1000;
// Look-ahead cap for one-shot templates so we don't pull rows dated decades
// out. One year is generous; tighten if the table grows large.
const ONE_SHOT_LOOKAHEAD_DAYS = 365;

type TemplateRow = typeof schema.ticketTemplates.$inferSelect;

// Exported for unit tests so the loop can be advanced manually without
// waiting 60s. Returns the number of templates that fired.
export async function tickTemplates(now: Date = new Date()): Promise<number> {
  // Split into two index-friendly queries — one for each schedule mode.
  // The OR-form forced a fallback to the generic enabled index; this
  // hits `scheduled_idx` and `trigger_idx` (partial indexes) directly.
  const cap = new Date(now.getTime() + ONE_SHOT_LOOKAHEAD_DAYS * MS_PER_DAY).toISOString();
  const [recurring, oneShot] = await Promise.all([
    db.select().from(schema.ticketTemplates).where(
      and(
        eq(schema.ticketTemplates.enabled, true),
        isNotNull(schema.ticketTemplates.schedule_cron),
      ),
    ),
    db.select().from(schema.ticketTemplates).where(
      and(
        eq(schema.ticketTemplates.enabled, true),
        isNotNull(schema.ticketTemplates.trigger_at),
        lte(schema.ticketTemplates.trigger_at, cap),
        // One-shots that have already fired are still enabled=false (the
        // fire flips it), so the enabled filter above covers most. Belt-
        // and-suspenders against a crashed mid-fire run.
        isNull(schema.ticketTemplates.last_fired_at),
      ),
    ),
  ]);

  const templates = [...recurring, ...oneShot];
  let firedCount = 0;
  for (const tpl of templates) {
    try {
      const fired = await maybeFireTemplate(tpl, now);
      if (fired) firedCount++;
    } catch (err) {
      console.error(`[template-scheduler] template ${tpl.id} (${tpl.title}):`, err);
    }
  }
  return firedCount;
}

async function maybeFireTemplate(
  template: TemplateRow,
  now: Date,
): Promise<boolean> {
  // ─── recurring: cron expression in template's tz ────────────────────────
  if (template.schedule_cron) {
    const tz = template.schedule_tz ?? "UTC";
    // last_fired_at NULL = freshly-created → next-fire computed from
    // created_at so a new template fires on its NEXT scheduled tick rather
    // than catching up on history.
    const since = template.last_fired_at ?? template.created_at;
    const sinceDate = new Date(since);

    let nextFire: Date;
    try {
      const expr = CronExpressionParser.parse(template.schedule_cron, {
        currentDate: sinceDate,
        tz,
      });
      nextFire = expr.next().toDate();
    } catch (err) {
      console.error(
        `[template-scheduler] invalid cron for template ${template.id}: ${template.schedule_cron} (${err})`,
      );
      return false;
    }

    if (nextFire > now) return false; // not due yet

    return await fireTemplate(template, now, /* oneShot */ false);
  }

  // ─── one-shot: fire at trigger_at - lead_days ──────────────────────────
  if (template.trigger_at) {
    if (template.last_fired_at) return false; // already fired once
    const triggerMs = new Date(template.trigger_at).getTime();
    const leadMs = (template.lead_days ?? 0) * MS_PER_DAY;
    const fireAt = new Date(triggerMs - leadMs);
    if (fireAt > now) return false; // not yet
    return await fireTemplate(template, now, /* oneShot */ true);
  }

  // Should be unreachable thanks to the DB XOR check.
  return false;
}

// Single fire: stamp last_fired_at, optionally disable for one-shot,
// then materialize. The stamp happens BEFORE the materialize transaction
// so a slow materialize can't be reentered by the next tick. (The
// materializer runs in its own transaction; the stamp here is a single
// UPDATE.)
async function fireTemplate(
  template: TemplateRow,
  now: Date,
  oneShot: boolean,
): Promise<boolean> {
  const sets: { last_fired_at: string; enabled?: boolean; updated_at: string } = {
    last_fired_at: now.toISOString(),
    updated_at: now.toISOString(),
  };
  if (oneShot) sets.enabled = false;

  await db
    .update(schema.ticketTemplates)
    .set(sets)
    .where(eq(schema.ticketTemplates.id, template.id));

  await db.transaction(async (tx) => {
    // The Tx type in the materializer asks for the full db shape; the
    // transaction object is structurally compatible but Drizzle's types
    // don't model that. Same `as any` shortcut writeEvent callers use.
    const result = await materializeFromTemplate(tx as any, template, now);
    if (result.kind === "skipped") {
      console.log(
        `[template-scheduler] template ${template.id} (${template.title}) fire skipped (overlap_skip)`,
      );
    } else {
      console.log(
        `[template-scheduler] template ${template.id} (${template.title}) ${result.kind} ticket ${result.ticket.id}`,
      );
    }
  });

  return true;
}
