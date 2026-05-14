// Ticket-template scheduler tick (SWY-43 Phase 4.7).
//
// Called from the existing rules scheduler's 60s loop alongside the rules
// tick. Polls enabled templates, computes next-fire from cron+tz (recurring)
// or `trigger_at - lead_days` (one-shot), materializes a ticket via the
// materializer when due, and stamps last_fired_at BEFORE the materialize
// so concurrent ticks can't double-fire.

import { and, eq, isNotNull, lte, or, type SQL } from "drizzle-orm";
import { CronExpressionParser } from "cron-parser";
import * as schema from "../../../drizzle/schema.js";
import { db } from "../../db.js";
import { materializeFromTemplate } from "./materializer.js";

type TemplateRow = typeof schema.ticketTemplates.$inferSelect;

// Exported for unit tests so the loop can be advanced manually without
// waiting 60s. Returns the number of templates that fired.
export async function tickTemplates(now: Date = new Date()): Promise<number> {
  const nowIso = now.toISOString();

  // Select enabled templates that COULD fire — recurring (any cron) or
  // one-shot whose trigger is at-or-before "now + lead_days". The actual
  // fire-time check happens per-row below.
  const templates = await db
    .select()
    .from(schema.ticketTemplates)
    .where(
      and(
        eq(schema.ticketTemplates.enabled, true),
        or(
          isNotNull(schema.ticketTemplates.schedule_cron),
          // For one-shot, the cheap filter is `trigger_at <= now + 365d` so
          // we don't load templates dated decades out. Keep the precise
          // check (with lead_days) inside the per-row branch.
          lte(schema.ticketTemplates.trigger_at, new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000).toISOString()),
        ) as SQL,
      ),
    );

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
    const triggerMs = new Date(template.trigger_at).getTime();
    const leadMs = (template.lead_days ?? 0) * 24 * 60 * 60 * 1000;
    const fireAt = new Date(triggerMs - leadMs);
    if (fireAt > now) return false; // not yet
    if (template.last_fired_at) return false; // already fired once
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
