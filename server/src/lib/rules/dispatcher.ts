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

import { eq, inArray, sql } from "drizzle-orm";
import { db, schema } from "../../db.js";
import { env } from "../../env.js";
import { mapUserRef } from "../mappers.js";
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

export function dispatcherInflight(): number {
  return inflight;
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
  rule_id: string;
  event_id: string | null;
  attempts: number;
  rule_name: string;
  rule_project_id: string;
  rule_enabled: boolean;
  rule_conditions: unknown;
  rule_actions: unknown;
  event_type: string | null;
  event_payload: unknown;
};

async function processBatch(): Promise<number> {
  const claimed = await db.transaction(async (tx) => {
    const rows = (await tx.execute(sql`
      SELECT
        f.id            AS firing_id,
        f.rule_id       AS rule_id,
        f.event_id      AS event_id,
        f.attempts      AS attempts,
        r.name          AS rule_name,
        r.project_id    AS rule_project_id,
        r.enabled       AS rule_enabled,
        r.conditions    AS rule_conditions,
        r.actions       AS rule_actions,
        e.event_type    AS event_type,
        e.payload       AS event_payload
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

    // Rule disabled mid-flight or its event missing → skipped.
    if (!row.rule_enabled) {
      await markSkipped(row.firing_id, newAttempts, "rule disabled", { skip_reason: "rule disabled" });
      return;
    }
    if (!row.event_type || row.event_payload == null) {
      await markSkipped(row.firing_id, newAttempts, "event missing", { skip_reason: "event missing" });
      return;
    }

    const payload = row.event_payload as Record<string, unknown>;
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
      event_type: row.event_type,
      event_payload: payload,
      rule: { id: row.rule_id, name: row.rule_name, project_id: row.rule_project_id },
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
