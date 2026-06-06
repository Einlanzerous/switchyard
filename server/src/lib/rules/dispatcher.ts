// Rule dispatcher — mirrors webhooks/dispatcher.ts.
//
// Polls `rule_firings` for work, claims via FOR UPDATE SKIP LOCKED, evaluates
// each firing's conditions, runs the actions, and records the outcome.
//
// Retry semantics differ from webhooks: action failures are usually
// deterministic (a missing assignee, a bad transition target), so retrying
// just amplifies the noise. We cap attempts at RULE_FIRING_MAX_ATTEMPTS
// (default 3) but the dispatcher does NOT auto-reschedule a failed firing.
// Admins redeliver explicitly via POST /v1/rules/firings/{id}/redeliver,
// which sets status back to pending and clears next_attempt_at.

import { and, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { db, schema } from "../../db.js";
import { env } from "../../env.js";
import { mapUserRef } from "../mappers.js";
import { loadTicketSummary } from "../tickets.js";
import type { TicketSummary as ApiTicketSummary } from "@switchyard/shared";
import { evaluate } from "./evaluator.js";
import { runAction } from "./actions.js";
import type {
  RuleAction, RuleConditions, UserRef,
} from "@switchyard/shared";
import type {
  RuleContext, FiringOutcome, ActionOutcome,
} from "./types.js";

const POLL_IDLE_MS = 1_000;
const POLL_BUSY_MS = 50;

let running = false;
let loopPromise: Promise<void> | null = null;
let inflight = 0;

// Resolved at start time. The rule dispatcher needs the rules-engine user
// row to attribute actions; we cache it once at boot instead of looking it
// up per firing.
let rulesEngineUserId: string | null = null;
let rulesEngineActor: UserRef | null = null;

export function startDispatcher(): void {
  if (running) return;
  running = true;
  loopPromise = bootstrap()
    .then(() => loop())
    .catch((err) => {
      console.error("[rules-dispatcher] loop crashed:", err);
      running = false;
    });
  console.log("[rules-dispatcher] started");
}

export async function stopDispatcher(deadlineMs = 5_000): Promise<void> {
  if (!running) return;
  running = false;
  console.log(`[rules-dispatcher] stopping (drain deadline ${deadlineMs}ms)`);

  const start = Date.now();
  while (inflight > 0 && Date.now() - start < deadlineMs) {
    await sleep(50);
  }
  if (inflight > 0) {
    console.warn(`[rules-dispatcher] forced stop with ${inflight} in flight`);
  }
  if (loopPromise) await loopPromise.catch(() => {});
}

function dispatcherInflight(): number {
  return inflight;
}

// Test-only: drop the cached bootstrap state so the next startDispatcher()
// re-resolves the rules-engine user. Used by integration tests that
// TRUNCATE users between cases — without it the dispatcher keeps writing
// events with a now-deleted actor_id and hits an FK violation.
export function _resetForTesting(): void {
  running = false;
  loopPromise = null;
  rulesEngineUserId = null;
  rulesEngineActor = null;
}

// Used by lib/events.ts to skip rule fan-out for rule-authored events.
export function getRulesEngineUserId(): string | null {
  return rulesEngineUserId;
}

async function bootstrap(): Promise<void> {
  // Resolve the rules-engine user. If the seeder hasn't created it yet
  // (test runs against a non-seeded DB, brand-new install) we crash loudly —
  // the engine cannot function without an actor.
  const [user] = await db
    .select()
    .from(schema.users)
    .where(eq(schema.users.name, "rules-engine"))
    .limit(1);
  if (!user) {
    throw new Error("[rules-dispatcher] rules-engine user not found — run db:migrate");
  }
  rulesEngineUserId = user.id;
  rulesEngineActor = mapUserRef(user);
}

// ─── internals ──────────────────────────────────────────────────────────────

async function loop(): Promise<void> {
  while (running) {
    let processed = 0;
    try {
      processed = await processBatch();
    } catch (err) {
      console.error("[rules-dispatcher] batch error:", err);
    }
    await sleep(processed === 0 ? POLL_IDLE_MS : POLL_BUSY_MS);
  }
}

type ClaimedRow = {
  firing_id: string;
  firing_created_at: string;
  rule_id: string;
  event_id: string | null;
  ticket_id: string | null;
  attempts: number;
  rule_name: string;
  rule_project_id: string | null;
  rule_enabled: boolean;
  rule_conditions: unknown;
  rule_actions: unknown;
  rule_webhook_secret: string | null;
  event_type: string | null;
  event_payload: unknown;
};

async function processBatch(): Promise<number> {
  const claimed = await db.transaction(async (tx) => {
    const rows = (await tx.execute(sql`
      SELECT
        f.id            AS firing_id,
        f.created_at    AS firing_created_at,
        f.rule_id       AS rule_id,
        f.event_id      AS event_id,
        f.ticket_id     AS ticket_id,
        f.attempts      AS attempts,
        r.name           AS rule_name,
        r.project_id     AS rule_project_id,
        r.enabled        AS rule_enabled,
        r.conditions     AS rule_conditions,
        r.actions        AS rule_actions,
        r.webhook_secret AS rule_webhook_secret,
        e.event_type     AS event_type,
        e.payload        AS event_payload
      FROM rule_firings f
      JOIN rules r ON r.id = f.rule_id
      LEFT JOIN events e ON e.id = f.event_id
      WHERE f.status IN ('pending', 'failed')
        AND (f.next_attempt_at IS NULL OR f.next_attempt_at <= now())
      ORDER BY f.created_at
      LIMIT ${sql.raw(String(env.RULE_BATCH_SIZE))}
      FOR UPDATE OF f SKIP LOCKED
    `)) as unknown as ClaimedRow[];

    if (rows.length === 0) return [] as ClaimedRow[];

    await tx
      .update(schema.ruleFirings)
      .set({ status: "running" })
      .where(inArray(schema.ruleFirings.id, rows.map((r) => r.firing_id)));

    return rows;
  });

  if (claimed.length === 0) return 0;

  await Promise.all(claimed.map(processOne));
  return claimed.length;
}

async function processOne(row: ClaimedRow): Promise<void> {
  inflight++;
  const newAttempts = row.attempts + 1;
  try {
    if (!rulesEngineUserId || !rulesEngineActor) {
      // Shouldn't happen post-bootstrap, but recover gracefully.
      await markFailed(row.firing_id, newAttempts, "dispatcher not bootstrapped", null);
      return;
    }

    // Rule disabled mid-flight or its triggering context missing → skipped.
    if (!row.rule_enabled) {
      await markSkipped(row.firing_id, newAttempts, "rule disabled", { skip_reason: "rule disabled" });
      return;
    }
    // Two trigger modes:
    //   - Event-triggered: row.event_id set, row.event_type + payload populated
    //     from the JOIN on events.
    //   - Scheduled (4.2+): row.event_id null, row.ticket_id set. We
    //     synthesize a payload below from the targeted ticket.
    const isScheduled = row.event_id === null && row.ticket_id !== null;
    if (!isScheduled && (!row.event_type || row.event_payload == null)) {
      await markSkipped(row.firing_id, newAttempts, "event missing", { skip_reason: "event missing" });
      return;
    }

    // Rate-limit gate. Count this rule's firings that were enqueued
    // strictly BEFORE this one (within the trailing hour). If
    // that count is already at the cap, this firing is over the limit
    // and gets skipped. Counting "strictly before" makes the gate
    // deterministic when a burst of firings shares a batch — each one
    // is judged against history, not against its concurrent peers.
    //
    // Re-read from process.env at runtime so integration tests can
    // override the limit without forcing the env module to re-parse.
    const rateLimit = readPositiveInt(process.env.RULE_RATE_LIMIT_PER_HOUR, env.RULE_RATE_LIMIT_PER_HOUR);
    const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const [recent] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.ruleFirings)
      .where(and(
        eq(schema.ruleFirings.rule_id, row.rule_id),
        gte(schema.ruleFirings.created_at, hourAgo),
        lt(schema.ruleFirings.created_at, row.firing_created_at),
      ));
    if ((recent?.count ?? 0) >= rateLimit) {
      await markSkipped(row.firing_id, newAttempts, "rate_limited", {
        skip_reason: `rate_limited (>=${rateLimit}/hour)`,
      });
      return;
    }

    // Build the payload the evaluator + actions see. For event-triggered
    // firings this is just the stored event_payload. For scheduled firings
    // we synthesize one from the targeted ticket so actions like
    // `comment` / `assign` / `set_field` can read `ticket.*` paths the
    // same way they do for event-triggered runs.
    let payload: Record<string, unknown>;
    let effectiveEventType: string;
    if (isScheduled) {
      const summary = await loadScheduledTicketSummary(row.ticket_id!);
      if (!summary) {
        await markSkipped(row.firing_id, newAttempts, "ticket missing", {
          skip_reason: "scheduled firing target ticket no longer exists",
        });
        return;
      }
      payload = { actor: rulesEngineActor, ticket: summary };
      effectiveEventType = "rule.scheduled";
    } else {
      payload = row.event_payload as Record<string, unknown>;
      effectiveEventType = row.event_type!;
    }

    const conditions = (row.rule_conditions ?? {}) as RuleConditions;
    const actions = (row.rule_actions ?? []) as RuleAction[];

    const evalOut = evaluate(payload, conditions);
    if (!evalOut.matched) {
      await markSkipped(row.firing_id, newAttempts, null, {
        conditions_matched: false,
        skip_reason: evalOut.reason ?? "conditions false",
      });
      return;
    }

    const ctx: RuleContext = {
      event_id: row.event_id ?? "",
      event_type: effectiveEventType,
      event_payload: payload,
      rule: {
        id: row.rule_id,
        name: row.rule_name,
        project_id: row.rule_project_id ?? "",
        webhook_secret: row.rule_webhook_secret,
      },
      rules_engine_user_id: rulesEngineUserId,
      rulesEngineActor,
    };

    const results: ActionOutcome[] = [];
    for (const action of actions) {
      const r = await runAction(action, ctx);
      results.push(r);
      // Stop on first failed action so a failed `set_field` doesn't get
      // followed by a successful `comment` that references stale state.
      if (r.status === "error") break;
    }

    const anyError = results.some((r) => r.status === "error");
    const firstError = results.find((r) => r.status === "error");

    const outcome: FiringOutcome = anyError
      ? {
          status: "failed",
          result_summary: { conditions_matched: true, actions: results },
          last_error: firstError?.error ?? "action failed",
        }
      : {
          status: "succeeded",
          result_summary: { conditions_matched: true, actions: results },
          last_error: null,
        };

    if (outcome.status === "succeeded") {
      await markSucceeded(row.firing_id, newAttempts, outcome.result_summary);
      await db
        .update(schema.rules)
        .set({ last_fired_at: new Date().toISOString() })
        .where(eq(schema.rules.id, row.rule_id));
    } else {
      // Abandon when out of attempts; otherwise leave at failed with no
      // scheduled retry (admin redelivers).
      if (newAttempts >= env.RULE_FIRING_MAX_ATTEMPTS) {
        await markAbandoned(row.firing_id, newAttempts, outcome.last_error, outcome.result_summary);
      } else {
        await markFailed(row.firing_id, newAttempts, outcome.last_error, outcome.result_summary);
      }
    }
  } finally {
    inflight--;
  }
}

async function markSucceeded(
  id: string,
  attempts: number,
  summary: FiringOutcome["result_summary"]
): Promise<void> {
  await db
    .update(schema.ruleFirings)
    .set({
      status: "succeeded",
      attempts,
      last_error: null,
      last_attempt_at: new Date().toISOString(),
      next_attempt_at: null,
      result_summary: summary as any,
    })
    .where(eq(schema.ruleFirings.id, id));
}

async function markSkipped(
  id: string,
  attempts: number,
  errorMsg: string | null,
  summary: FiringOutcome["result_summary"]
): Promise<void> {
  await db
    .update(schema.ruleFirings)
    .set({
      status: "skipped",
      attempts,
      last_error: errorMsg,
      last_attempt_at: new Date().toISOString(),
      next_attempt_at: null,
      result_summary: summary as any,
    })
    .where(eq(schema.ruleFirings.id, id));
}

async function markFailed(
  id: string,
  attempts: number,
  errorMsg: string | null,
  summary: FiringOutcome["result_summary"] | null
): Promise<void> {
  await db
    .update(schema.ruleFirings)
    .set({
      status: "failed",
      attempts,
      last_error: errorMsg,
      last_attempt_at: new Date().toISOString(),
      next_attempt_at: null,
      result_summary: summary as any,
    })
    .where(eq(schema.ruleFirings.id, id));
}

async function markAbandoned(
  id: string,
  attempts: number,
  errorMsg: string | null,
  summary: FiringOutcome["result_summary"]
): Promise<void> {
  await db
    .update(schema.ruleFirings)
    .set({
      status: "abandoned",
      attempts,
      last_error: errorMsg,
      last_attempt_at: new Date().toISOString(),
      next_attempt_at: null,
      result_summary: summary as any,
    })
    .where(eq(schema.ruleFirings.id, id));
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function readPositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

// Build the TicketSummary that scheduled firings hand to the evaluator +
// actions. Walks the same shape `loadTicketSummary` returns for event-
// triggered runs so the payload is uniform across both modes.
async function loadScheduledTicketSummary(ticket_id: string): Promise<ApiTicketSummary | null> {
  const [ticket] = await db.select().from(schema.tickets).where(eq(schema.tickets.id, ticket_id)).limit(1);
  if (!ticket) return null;
  return await loadTicketSummary(ticket);
}
