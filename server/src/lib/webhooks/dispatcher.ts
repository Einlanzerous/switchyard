// In-process webhook dispatcher.
//
// One async loop per process polls webhook_deliveries for work, claims rows
// using FOR UPDATE SKIP LOCKED (so we'd be safe even if we ever ran multiple
// processes), POSTs to subscribers, and either marks `succeeded` or schedules
// the next retry.
//
// Backoff: 1s, 4s, 16s, 64s, 256s on attempts 1..5, then `abandoned`. A user
// can re-queue any abandoned delivery via POST /v1/webhooks/deliveries/{id}/redeliver
// (which sets status back to `pending`, attempts back to 0, next_attempt_at to now).
//
// Graceful shutdown: stopDispatcher() flips the run flag and waits for inflight
// requests to settle (default 5s). Anything not yet dispatched stays in
// `pending` and gets picked up by the next process boot.

import { eq, inArray, sql } from "drizzle-orm";
import { db, schema } from "../../db.js";
import { env } from "../../env.js";
import { signHmac } from "../hmac.js";

const BACKOFF_SECONDS = [1, 4, 16, 64, 256] as const;
const POLL_IDLE_MS = 1_000;
const POLL_BUSY_MS = 50;

let running = false;
let loopPromise: Promise<void> | null = null;
let inflight = 0;

export function startDispatcher(): void {
  if (running) return;
  running = true;
  loopPromise = loop().catch((err) => {
    console.error("[dispatcher] loop crashed:", err);
    running = false;
  });
  console.log("[dispatcher] started");
}

export async function stopDispatcher(deadlineMs = 5_000): Promise<void> {
  if (!running) return;
  running = false;
  console.log(`[dispatcher] stopping (drain deadline ${deadlineMs}ms)`);

  const start = Date.now();
  while (inflight > 0 && Date.now() - start < deadlineMs) {
    await sleep(50);
  }
  if (inflight > 0) {
    console.warn(`[dispatcher] forced stop with ${inflight} in flight`);
  }
  if (loopPromise) await loopPromise.catch(() => {});
}

export function dispatcherInflight(): number {
  return inflight;
}

// ─── internals ──────────────────────────────────────────────────────────────

async function loop(): Promise<void> {
  while (running) {
    let processed = 0;
    try {
      processed = await processBatch();
    } catch (err) {
      console.error("[dispatcher] batch error:", err);
    }
    await sleep(processed === 0 ? POLL_IDLE_MS : POLL_BUSY_MS);
  }
}

type ClaimedRow = {
  id: string;
  subscription_id: string;
  event_id: string;
  attempts: number;
  url: string;
  secret: string;
  // Phase 4.2.5: static headers from the resolved target (null when
  // the subscription has no target or the target has no headers).
  target_headers: Record<string, string> | null;
  event_type: string;
  payload: unknown;
};

async function processBatch(): Promise<number> {
  // Claim a batch in one transaction. SKIP LOCKED keeps multiple instances
  // from grabbing the same row (we're single-instance today, but cheap insurance).
  //
  // Phase 4.2.5: LEFT JOIN on targets. When the subscription has a
  // target_id, coalesce(target.url, s.url) gives target precedence;
  // same for the signing secret. ON DELETE SET NULL on the FK means a
  // deleted target falls back to the subscription's literal columns.
  const claimed = await db.transaction(async (tx) => {
    const rows = (await tx.execute(sql`
      SELECT
        d.id,
        d.subscription_id,
        d.event_id,
        d.attempts,
        coalesce(t.url, s.url)              AS url,
        coalesce(t.hmac_secret, s.secret)   AS secret,
        t.headers                           AS target_headers,
        e.event_type,
        e.payload
      FROM webhook_deliveries d
      JOIN webhook_subscriptions s ON s.id = d.subscription_id
      LEFT JOIN targets t ON t.id = s.target_id
      JOIN events e ON e.id = d.event_id
      WHERE d.status IN ('pending', 'failed')
        AND d.next_attempt_at <= now()
        AND s.active = true
      ORDER BY d.next_attempt_at
      LIMIT ${sql.raw(String(env.WEBHOOK_BATCH_SIZE))}
      FOR UPDATE OF d SKIP LOCKED
    `)) as unknown as ClaimedRow[];

    if (rows.length === 0) return [] as ClaimedRow[];

    const ids = rows.map((r) => r.id);
    await tx
      .update(schema.webhookDeliveries)
      .set({ status: "delivering" })
      .where(inArray(schema.webhookDeliveries.id, ids));

    return rows;
  });

  if (claimed.length === 0) return 0;

  // Fire all claimed deliveries in parallel; each result is independent.
  await Promise.all(claimed.map(deliverOne));
  return claimed.length;
}

async function deliverOne(row: ClaimedRow): Promise<void> {
  inflight++;
  const startedAt = Date.now();
  let responseCode: number | null = null;
  let responseExcerpt: string | null = null;
  let lastError: string | null = null;
  const newAttempts = row.attempts + 1;

  // The events.payload field already contains the full webhook-shaped envelope
  // (actor, ticket, changes, extras) — see writeEvent. We add the top-level
  // wrapper fields (id, event, occurred_at) here.
  const envelope = {
    id: row.event_id,
    event: row.event_type,
    occurred_at: new Date().toISOString(),
    ...(typeof row.payload === "object" && row.payload !== null ? row.payload : {}),
  };
  const body = JSON.stringify(envelope);
  const signature = signHmac(row.secret, body);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), env.WEBHOOK_TIMEOUT_MS);

  try {
    // Phase 4.2.5: target-attached subscriptions get the target's
    // static headers merged in. Standard switchyard headers (signature,
    // event, delivery, UA, content-type) override on collision so the
    // receiver always sees the canonical envelope metadata.
    const res = await fetch(row.url, {
      method: "POST",
      headers: {
        ...(row.target_headers ?? {}),
        "Content-Type": "application/json",
        "X-Switchyard-Signature": `sha256=${signature}`,
        "X-Switchyard-Event": row.event_type,
        "X-Switchyard-Delivery": row.id,
        "User-Agent": "switchyard/0.0.0",
      },
      body,
      signal: controller.signal,
    });
    responseCode = res.status;
    responseExcerpt = await readExcerpt(res);

    if (res.ok) {
      await markSucceeded(row.id, newAttempts, responseCode, responseExcerpt);
      return;
    }
    lastError = `HTTP ${responseCode}`;
  } catch (err) {
    lastError =
      err instanceof Error
        ? err.name === "AbortError"
          ? `timeout after ${env.WEBHOOK_TIMEOUT_MS}ms`
          : err.message
        : String(err);
  } finally {
    clearTimeout(timeout);
    inflight--;
    void startedAt; // reserved for structured logs in milestone 1.6
  }

  await markFailedOrAbandoned(row.id, newAttempts, responseCode, responseExcerpt, lastError);
}

async function readExcerpt(res: Response): Promise<string | null> {
  try {
    const text = await res.text();
    return text.slice(0, 500);
  } catch {
    return null;
  }
}

async function markSucceeded(
  id: string,
  attempts: number,
  code: number | null,
  excerpt: string | null
): Promise<void> {
  await db
    .update(schema.webhookDeliveries)
    .set({
      status: "succeeded",
      attempts,
      response_code: code,
      response_body_excerpt: excerpt,
      last_error: null,
      last_attempt_at: new Date().toISOString(),
      next_attempt_at: null,
    })
    .where(eq(schema.webhookDeliveries.id, id));
}

async function markFailedOrAbandoned(
  id: string,
  attempts: number,
  code: number | null,
  excerpt: string | null,
  err: string | null
): Promise<void> {
  if (attempts >= env.WEBHOOK_MAX_ATTEMPTS) {
    await db
      .update(schema.webhookDeliveries)
      .set({
        status: "abandoned",
        attempts,
        response_code: code,
        response_body_excerpt: excerpt,
        last_error: err,
        last_attempt_at: new Date().toISOString(),
        next_attempt_at: null,
      })
      .where(eq(schema.webhookDeliveries.id, id));
    return;
  }

  const backoff = BACKOFF_SECONDS[attempts - 1] ?? BACKOFF_SECONDS[BACKOFF_SECONDS.length - 1]!;
  const next = new Date(Date.now() + backoff * 1000).toISOString();

  await db
    .update(schema.webhookDeliveries)
    .set({
      status: "failed",
      attempts,
      response_code: code,
      response_body_excerpt: excerpt,
      last_error: err,
      last_attempt_at: new Date().toISOString(),
      next_attempt_at: next,
    })
    .where(eq(schema.webhookDeliveries.id, id));
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
