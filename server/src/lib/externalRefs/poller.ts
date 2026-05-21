// External ref state poller. Periodically refreshes `state` + `title`
// for github_* refs by hitting the GitHub REST API. Stamps
// `polled_state_changed_at` and emits `ticket.external_ref_state_changed`
// when the state transitions.
//
// Push-mode updates (4.5.3) will populate the same rows from a webhook
// receiver; this loop stays active as the reconciliation backstop so a
// missed webhook delivery doesn't leave a stale state forever.

import { and, asc, eq, inArray, isNull, lt, or } from "drizzle-orm";
import * as schema from "../../../drizzle/schema.js";
import { db } from "../../db.js";
import { env } from "../../env.js";
import { writeEvent } from "../events.js";
import { mapUserRef } from "../mappers.js";
import { loadTicketSummary } from "../tickets.js";
import { EXTERNAL_REF_POLLER_USER_NAME } from "../seed.js";
import { parseGitHubUrl } from "./detectKind.js";
import type { ExternalRefState } from "@switchyard/shared";

const POLL_TICK_MS = 60_000; // re-check the queue every minute
const USER_AGENT = "switchyard/0.0.0";

let running = false;
let timer: ReturnType<typeof setInterval> | null = null;
let inflight = 0;

export function startExternalRefPoller(): void {
  if (running) return;
  running = true;
  if (!env.GITHUB_TOKEN) {
    console.log("[external-ref-poller] GITHUB_TOKEN unset — polling disabled, attached refs will not refresh state");
    // We don't return — the loop still starts so `_tickOnce` callers
    // (tests) can drive it; the per-ref fetch short-circuits below.
  } else {
    console.log("[external-ref-poller] started");
  }
  timer = setInterval(() => {
    void tick().catch((err) => console.error("[external-ref-poller] tick error:", err));
  }, POLL_TICK_MS);
}

export async function stopExternalRefPoller(deadlineMs = 5_000): Promise<void> {
  if (!running) return;
  running = false;
  if (timer) clearInterval(timer);
  timer = null;
  const start = Date.now();
  while (inflight > 0 && Date.now() - start < deadlineMs) {
    await new Promise((r) => setTimeout(r, 50));
  }
  console.log("[external-ref-poller] stopped");
}

// Test seam — drives one tick synchronously without waiting for the
// interval. Also used to drop in-memory state between tests.
export async function _tickOnce(): Promise<number> {
  return tick();
}

export function _resetForTesting(): void {
  if (timer) clearInterval(timer);
  timer = null;
  running = false;
  inflight = 0;
}

// ─── internals ──────────────────────────────────────────────────────────────

async function tick(): Promise<number> {
  if (!env.GITHUB_TOKEN) return 0;

  // Pick the oldest unpolled / stalest entries. `kind = 'generic'` is
  // filtered out by the partial index this query targets.
  const cutoff = new Date(Date.now() - env.EXTERNAL_REF_POLL_INTERVAL_MS).toISOString();
  const rows = await db
    .select()
    .from(schema.ticketExternalRefs)
    .where(and(
      // generic refs have no GitHub-side state to poll
      or(
        eq(schema.ticketExternalRefs.kind, "github_pr"),
        eq(schema.ticketExternalRefs.kind, "github_issue"),
        eq(schema.ticketExternalRefs.kind, "github_commit"),
        eq(schema.ticketExternalRefs.kind, "github_action"),
      ),
      or(
        isNull(schema.ticketExternalRefs.polled_at),
        lt(schema.ticketExternalRefs.polled_at, cutoff),
      ),
    ))
    .orderBy(asc(schema.ticketExternalRefs.polled_at))
    .limit(env.EXTERNAL_REF_POLL_BATCH_SIZE);

  if (rows.length === 0) return 0;

  await Promise.all(rows.map(refreshOne));
  return rows.length;
}

async function refreshOne(row: typeof schema.ticketExternalRefs.$inferSelect): Promise<void> {
  inflight++;
  try {
    const next = await fetchGitHubState(row);
    if (next === null) return; // hard failure (404, auth) — leave row alone but mark polled
    const nowIso = new Date().toISOString();
    const stateChanged = row.state !== next.state;
    await db
      .update(schema.ticketExternalRefs)
      .set({
        state: next.state,
        title: next.title ?? row.title,
        polled_at: nowIso,
        polled_state_changed_at: stateChanged ? nowIso : row.polled_state_changed_at,
      })
      .where(eq(schema.ticketExternalRefs.id, row.id));

    if (stateChanged) await emitStateChanged(row, next.state);
  } catch (err) {
    console.warn(`[external-ref-poller] ${row.url}: ${err instanceof Error ? err.message : err}`);
    // Stamp polled_at anyway so a permanently-broken ref doesn't block
    // the queue — it'll come back to the front of the line in another
    // poll-interval but downstream refs aren't starved meanwhile.
    await db
      .update(schema.ticketExternalRefs)
      .set({ polled_at: new Date().toISOString() })
      .where(eq(schema.ticketExternalRefs.id, row.id));
  } finally {
    inflight--;
  }
}

type FetchResult = { state: ExternalRefState | null; title: string | null };

async function fetchGitHubState(row: typeof schema.ticketExternalRefs.$inferSelect): Promise<FetchResult | null> {
  const parsed = parseGitHubUrl(row.url);
  if (!parsed) return null;

  // Map URL path → REST API path. Kinds we don't have an API path for
  // (commit / action) stamp polled_at and move on without state.
  let apiPath: string | null = null;
  switch (row.kind) {
    case "github_pr": {
      const m = parsed.rest.match(/^pull\/(\d+)/);
      if (!m) return null;
      apiPath = `/repos/${parsed.owner}/${parsed.repo}/pulls/${m[1]}`;
      break;
    }
    case "github_issue": {
      const m = parsed.rest.match(/^issues\/(\d+)/);
      if (!m) return null;
      apiPath = `/repos/${parsed.owner}/${parsed.repo}/issues/${m[1]}`;
      break;
    }
    case "github_action": {
      const m = parsed.rest.match(/^actions\/runs\/(\d+)/);
      if (!m) return null;
      apiPath = `/repos/${parsed.owner}/${parsed.repo}/actions/runs/${m[1]}`;
      break;
    }
    case "github_commit":
      // Commits don't have a moving "state" the way PRs do — they exist
      // or they don't. Skip polling.
      return { state: row.state, title: row.title };
    case "generic":
      return null;
  }

  if (!apiPath) return null;

  const res = await fetch(`https://api.github.com${apiPath}`, {
    headers: {
      "Authorization": `Bearer ${env.GITHUB_TOKEN}`,
      "Accept": "application/vnd.github+json",
      "User-Agent": USER_AGENT,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!res.ok) {
    if (res.status === 404 || res.status === 401 || res.status === 403) {
      // Permanent failure for this ref — log once, don't crash the loop.
      throw new Error(`HTTP ${res.status}`);
    }
    throw new Error(`HTTP ${res.status}`);
  }
  const body = (await res.json()) as Record<string, unknown>;

  // Map GitHub's representation → our state enum.
  let state: ExternalRefState | null = null;
  switch (row.kind) {
    case "github_pr": {
      // body.state ∈ {"open","closed"}; body.merged ∈ true/false.
      if (body.merged === true) state = "merged";
      else if (body.state === "closed") state = "closed";
      else state = "open";
      break;
    }
    case "github_issue":
      state = body.state === "closed" ? "closed" : "open";
      break;
    case "github_action": {
      // body.conclusion ∈ {"success","failure","cancelled","skipped","timed_out",null}
      const conclusion = body.conclusion as string | null;
      if (conclusion === "success") state = "success";
      else if (conclusion === "failure" || conclusion === "timed_out" || conclusion === "cancelled") state = "failed";
      else state = "open"; // still running / queued
      break;
    }
    default:
      state = null;
  }

  const title = (typeof body.title === "string" && body.title.length > 0)
    ? body.title
    : (typeof body.name === "string" ? body.name : null);

  return { state, title };
}

async function emitStateChanged(
  row: typeof schema.ticketExternalRefs.$inferSelect,
  newState: ExternalRefState | null,
): Promise<void> {
  // Look up the ticket so we can render the summary in the event payload.
  const [ticket] = await db.select().from(schema.tickets)
    .where(eq(schema.tickets.id, row.ticket_id)).limit(1);
  if (!ticket) return;
  // Authored as `external-ref-poller`, NOT `rules-engine`. events.ts
  // loop-prevention skips rule-authored events; using the rules engine
  // here would drop the rule fan-out and prevent auto-close on PR merge.
  const [pollerUser] = await db.select().from(schema.users)
    .where(eq(schema.users.name, EXTERNAL_REF_POLLER_USER_NAME)).limit(1);

  await db.transaction(async (tx) => {
    const summary = await loadTicketSummary(ticket, tx as any);
    await writeEvent(tx as any, {
      event_type: "ticket.external_ref_state_changed",
      actor: pollerUser ? mapUserRef(pollerUser) : null,
      ticket: summary,
      project_id: ticket.project_id,
      extras: {
        external_ref_id: row.id,
        kind: row.kind,
        url: row.url,
        prev_state: row.state,
        new_state: newState,
      },
    });
  });
  // inArray imported for future batch refresh; not yet used.
  void inArray;
}
