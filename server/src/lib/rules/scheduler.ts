// Scheduled rule loop. Polls enabled scheduled rules every 60s, computes
// the next fire time from the cron expression + timezone + last_fired_at,
// and when due runs the rule's target_query against tickets, enqueueing
// one rule_firings row per match.
//
// The event-triggered dispatcher (`lib/rules/dispatcher.ts`) then picks
// those firings up, builds a synthetic event payload from the ticket,
// and runs the actions. Scheduler-side responsibilities end at enqueue;
// failures from actions surface on the firings log like any other.

import { and, eq, gt, inArray, isNotNull, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import { CronExpressionParser } from "cron-parser";
import * as schema from "../../../drizzle/schema.js";
import { db } from "../../db.js";
import { StatusCategory, TicketType, type ScheduledRuleTarget } from "@switchyard/shared";
import { tickTemplates } from "../templates/scheduler.js";

const POLL_INTERVAL_MS = 60_000;
// Cap per scheduled-tick result so a misconfigured target_query
// (e.g. wildcard date range against a busy install) doesn't enqueue
// tens of thousands of firings in one go. The per-rule rate limit
// (RULE_RATE_LIMIT_PER_HOUR) is the primary circuit breaker; this
// cap protects memory + INSERT batch size at fire-out time.
const TARGET_QUERY_LIMIT = 1_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUS_CATEGORIES = new Set<string>(StatusCategory.options);
const TICKET_TYPES = new Set<string>(TicketType.options);

let running = false;
let timer: ReturnType<typeof setInterval> | null = null;

export function startScheduler(): void {
  if (running) return;
  running = true;
  // Run once immediately so newly-due rules don't wait an extra minute
  // after a restart. Errors are swallowed and logged — a malformed cron
  // in one rule shouldn't block every other tick.
  void tick().catch((err) => console.error("[rules-scheduler] tick error:", err));
  timer = setInterval(() => {
    void tick().catch((err) => console.error("[rules-scheduler] tick error:", err));
  }, POLL_INTERVAL_MS);
  console.log("[rules-scheduler] started");
}

export async function stopScheduler(): Promise<void> {
  if (!running) return;
  running = false;
  if (timer) clearInterval(timer);
  timer = null;
  console.log("[rules-scheduler] stopped");
}

// Exported for tests so they can drive the loop without sleeping for the
// 60s tick. Returns the number of rules that fired (enqueued ≥1 firing).
export async function _tickOnce(now: Date = new Date()): Promise<number> {
  return tick(now);
}

// Test-only state reset (mirrors dispatcher._resetForTesting).
export function _resetForTesting(): void {
  if (timer) clearInterval(timer);
  timer = null;
  running = false;
}

// ─── internals ──────────────────────────────────────────────────────────────

async function tick(now: Date = new Date()): Promise<number> {
  const rules = await db
    .select()
    .from(schema.rules)
    .where(and(eq(schema.rules.enabled, true), isNotNull(schema.rules.schedule_cron)));

  let firedCount = 0;
  for (const rule of rules) {
    try {
      const fired = await maybeFireRule(rule, now);
      if (fired) firedCount++;
    } catch (err) {
      // One bad rule shouldn't stop the rest. Log + continue.
      console.error(`[rules-scheduler] rule ${rule.id} (${rule.name}):`, err);
    }
  }

  // Ticket templates ride the same 60s tick. Errors in the template pass
  // are handled inside tickTemplates() so they don't break the rule loop.
  try {
    const templateFires = await tickTemplates(now);
    firedCount += templateFires;
  } catch (err) {
    console.error("[rules-scheduler] template tick error:", err);
  }

  return firedCount;
}

async function maybeFireRule(
  rule: typeof schema.rules.$inferSelect,
  now: Date,
): Promise<boolean> {
  if (!rule.schedule_cron) return false;

  const tz = rule.schedule_tz ?? "UTC";
  // last_fired_at is null on a freshly-created rule. Compute next-fire
  // from rule.created_at in that case so a new rule fires at its next
  // scheduled tick rather than catching up on missed history.
  const since = rule.last_fired_at ?? rule.created_at;
  const sinceDate = new Date(since);

  let nextFire: Date;
  try {
    const expr = CronExpressionParser.parse(rule.schedule_cron, { currentDate: sinceDate, tz });
    nextFire = expr.next().toDate();
  } catch (err) {
    console.error(`[rules-scheduler] invalid cron for rule ${rule.id}: ${rule.schedule_cron} (${err})`);
    return false;
  }

  if (nextFire > now) return false; // not due yet

  // Stamp last_fired_at BEFORE running the query+enqueue so concurrent
  // ticks (e.g. unit-test manual + the 60s timer) don't double-fire.
  await db
    .update(schema.rules)
    .set({ last_fired_at: now.toISOString() })
    .where(eq(schema.rules.id, rule.id));

  // Resolve target query against tickets. An empty target_query (or
  // missing) is a no-op — the rule fires "on schedule" with nothing to
  // target. Future versions might support a "fire once globally" mode,
  // but for 4.2 we require at least one matched ticket to do useful work.
  const target = (rule.target_query ?? {}) as ScheduledRuleTarget;
  const matchedTicketIds = await queryTargetTickets(target);

  if (matchedTicketIds.length === 0) return true; // fired (tick advanced), no work

  const nowIso = new Date().toISOString();
  await db.insert(schema.ruleFirings).values(
    matchedTicketIds.map((ticket_id) => ({
      rule_id: rule.id,
      event_id: null,
      ticket_id,
      status: "pending" as const,
      next_attempt_at: nowIso,
    })),
  );

  return true;
}

// Build a tickets query from a ScheduledRuleTarget shape. Returns
// matched ticket ids. Subset of routes/tickets.ts list logic — kept
// inline so the scheduler doesn't pull in the route handler.
async function queryTargetTickets(target: ScheduledRuleTarget): Promise<string[]> {
  const conds: SQL[] = [isNull(schema.tickets.deleted_at)];

  if (target.project) {
    const keys = target.project.split(",").map((s) => s.trim()).filter(Boolean);
    if (keys.length > 0) {
      const projects = await db.select({ id: schema.projects.id }).from(schema.projects)
        .where(inArray(schema.projects.key, keys));
      if (projects.length === 0) return [];
      conds.push(inArray(schema.tickets.project_id, projects.map((p) => p.id)));
    }
  }

  if (target.status) {
    const values = target.status.split(",").map((s) => s.trim()).filter(Boolean);
    const ids: string[] = [];
    const cats: string[] = [];
    for (const v of values) {
      if (UUID_RE.test(v)) ids.push(v);
      else if (STATUS_CATEGORIES.has(v)) cats.push(v);
      else throw new Error(`scheduler: unknown status value "${v}"`);
    }
    const statusConds: SQL[] = [];
    if (ids.length > 0) statusConds.push(inArray(schema.tickets.status_id, ids));
    if (cats.length > 0) {
      statusConds.push(
        sql`EXISTS (SELECT 1 FROM statuses s WHERE s.id = ${schema.tickets.status_id} AND s.category = ANY(${sql.raw(`ARRAY[${cats.map((c) => `'${c}'`).join(",")}]::status_category[]`)}))`
      );
    }
    if (statusConds.length === 1) conds.push(statusConds[0]!);
    else if (statusConds.length > 1) conds.push(or(...statusConds)!);
  }

  if (target.type) {
    const types = target.type.split(",").map((s) => s.trim()).filter(Boolean);
    for (const t of types) {
      if (!TICKET_TYPES.has(t)) throw new Error(`scheduler: unknown ticket type "${t}"`);
    }
    conds.push(inArray(schema.tickets.type, types as any));
  }

  if (target.label) {
    const ids = target.label.split(",").map((s) => s.trim()).filter(Boolean);
    if (ids.length > 0) {
      conds.push(
        sql`EXISTS (SELECT 1 FROM ticket_labels tl WHERE tl.ticket_id = ${schema.tickets.id} AND tl.label_id = ANY(${sql.raw(`ARRAY[${ids.map((id) => `'${id}'`).join(",")}]::uuid[]`)}))`
      );
    }
  }

  if (target.assignee) {
    if (target.assignee === "unassigned") conds.push(isNull(schema.tickets.assignee_id));
    else conds.push(eq(schema.tickets.assignee_id, target.assignee));
  }

  if (target.reporter) conds.push(eq(schema.tickets.reporter_id, target.reporter));
  if (target.parent_id) conds.push(eq(schema.tickets.parent_id, target.parent_id));

  if (target.text) {
    const pattern = `%${target.text}%`;
    conds.push(or(sql`${schema.tickets.title} ILIKE ${pattern}`, sql`${schema.tickets.description} ILIKE ${pattern}`)!);
  }

  if (target.updated_after) conds.push(gt(schema.tickets.updated_at, target.updated_after));
  if (target.updated_before) conds.push(lt(schema.tickets.updated_at, target.updated_before));

  // limit + 1 so we can detect overflow and warn — actual fire-out uses
  // the first `TARGET_QUERY_LIMIT` rows.
  const rows = await db
    .select({ id: schema.tickets.id })
    .from(schema.tickets)
    .where(and(...conds))
    .limit(TARGET_QUERY_LIMIT + 1);
  if (rows.length > TARGET_QUERY_LIMIT) {
    console.warn(
      `[rules-scheduler] target_query matched > ${TARGET_QUERY_LIMIT} tickets; truncating. ` +
      `tighten the filter or trust the per-rule rate limit to skip the rest.`,
    );
  }
  return rows.slice(0, TARGET_QUERY_LIMIT).map((r) => r.id);
}
