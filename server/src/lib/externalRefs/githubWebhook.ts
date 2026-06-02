// GitHub webhook receiver helpers: handlePullRequestEvent wires a parsed
// pull_request payload to the existing ticket_external_refs upsert path. The
// receiver itself lives in routes/external.ts.
//
// The pure key parsers (parseKeyMentions / parseClosingKeyMentions) live in
// ./parseKeys.ts so they stay db/env-free and unit-testable without a
// database; they're re-exported here for the existing import surface.

import { and, eq, isNull } from "drizzle-orm";
import * as schema from "../../../drizzle/schema.js";
import { db } from "../../db.js";
import { writeEvent } from "../events.js";
import { loadTicketSummary } from "../tickets.js";
import { mapUserRef } from "../mappers.js";
import { detectKind } from "./detectKind.js";
import { parseKeyMentions, parseClosingKeyMentions } from "./parseKeys.js";
import type { ExternalRefState } from "@switchyard/shared";

export { parseKeyMentions, parseClosingKeyMentions } from "./parseKeys.js";

// PR action → state we want the ref to land at. We do NOT re-open a ref
// when GitHub does (re-opening a closed PR is rare, and operators can
// remove the ref manually if needed); state transitions only ratchet
// toward closed/merged.
export function pullRequestStateFromPayload(
  action: string,
  payload: { state?: string; merged?: boolean; merged_at?: string | null },
): ExternalRefState {
  // action ∈ {opened, edited, closed, reopened, synchronize, …}
  if (payload.merged === true) return "merged";
  if (payload.state === "closed") return "closed";
  return "open";
}

// Look up live tickets matching a list of keys. Returns the rows the
// caller can iterate over — the receiver fans these into per-row
// upserts. Soft-deleted tickets are excluded; mentioning a stale key
// is a no-op rather than an error so a PR that references a since-
// deleted ticket doesn't 5xx the receiver.
export async function resolveTicketsByKeys(
  keys: string[],
): Promise<typeof schema.tickets.$inferSelect[]> {
  if (keys.length === 0) return [];
  // Single query: outer-join projects by key, filter for live tickets.
  // Each key is `PROJECT-NUMBER` so we have to decompose them client-
  // side and build an OR. n is tiny (PRs reference a handful at most).
  const conditions = keys.map((k) => {
    const m = /^([A-Z][A-Z0-9]{1,9})-(\d+)$/.exec(k);
    if (!m) return null;
    return { key: m[1]!, number: Number(m[2]) };
  }).filter((x): x is { key: string; number: number } => x !== null);
  if (conditions.length === 0) return [];

  const rows: typeof schema.tickets.$inferSelect[] = [];
  for (const c of conditions) {
    const [t] = await db
      .select({ ticket: schema.tickets })
      .from(schema.tickets)
      .innerJoin(schema.projects, eq(schema.projects.id, schema.tickets.project_id))
      .where(and(
        eq(schema.projects.key, c.key),
        eq(schema.tickets.number, c.number),
        isNull(schema.tickets.deleted_at),
      ))
      .limit(1);
    if (t) rows.push(t.ticket);
  }
  return rows;
}

// Apply a GitHub pull_request webhook to switchyard state. Returns the
// number of tickets the PR was attached to / updated against so the
// receiver can log a useful summary.
export async function handlePullRequestEvent(payload: {
  action: string;
  pull_request: {
    html_url: string;
    title: string;
    body?: string | null;
    state: string;
    merged?: boolean;
    merged_at?: string | null;
    head?: { ref?: string };
  };
}, opts: { keyPrefix: string; pollerUserId: string }): Promise<number> {
  const pr = payload.pull_request;
  const title = pr.title ?? "";
  const branch = pr.head?.ref ?? "";
  const body = pr.body ?? "";
  const keys = [...new Set([
    // Title + branch: bare key mentions (terse, low false-positive).
    ...parseKeyMentions(title, opts.keyPrefix),
    ...parseKeyMentions(branch, opts.keyPrefix),
    // Body: only keys behind a closing keyword (see parseClosingKeyMentions).
    ...parseClosingKeyMentions(body, opts.keyPrefix),
  ])];
  if (keys.length === 0) return 0;

  const tickets = await resolveTicketsByKeys(keys);
  if (tickets.length === 0) return 0;

  const url = pr.html_url;
  const kind = detectKind(url); // always github_pr for a real PR url
  const newState = pullRequestStateFromPayload(payload.action, pr);
  const nowIso = new Date().toISOString();

  // System actor for the audit trail. Must NOT be `rules-engine` — the
  // events.ts loop-prevention drops rule-authored events before the
  // dispatcher sees them, which would silently kill any rule listening
  // on `ticket.external_ref_state_changed`. Caller (external.ts) supplies
  // the `external-ref-poller` system user id.
  const [pollerUser] = await db.select().from(schema.users)
    .where(eq(schema.users.id, opts.pollerUserId)).limit(1);

  let updated = 0;
  for (const ticket of tickets) {
    await db.transaction(async (tx) => {
      // Existing ref for this (ticket, url) pair?
      const [existing] = await tx.select().from(schema.ticketExternalRefs)
        .where(and(
          eq(schema.ticketExternalRefs.ticket_id, ticket.id),
          eq(schema.ticketExternalRefs.url, url),
        ))
        .limit(1);

      if (!existing) {
        // First time this PR is mentioned for this ticket → insert.
        const [created] = await tx.insert(schema.ticketExternalRefs).values({
          ticket_id: ticket.id,
          kind,
          url,
          state: newState,
          title,
          polled_at: nowIso,
          polled_state_changed_at: nowIso,
          created_by: opts.pollerUserId,
        }).returning();

        const summary = await loadTicketSummary(ticket, tx as any);
        await writeEvent(tx as any, {
          event_type: "ticket.external_ref_added",
          actor: pollerUser ? mapUserRef(pollerUser) : null,
          ticket: summary,
          project_id: ticket.project_id,
          extras: { external_ref_id: created?.id, kind, url, source: "github_webhook" },
        });
        updated++;
        return;
      }

      // Existing row — update title (PR titles can be edited) and
      // transition state when it changed. Don't re-open: if the row
      // is already merged/closed and the incoming state is "open"
      // (re-opened PR), leave the ref where it was.
      const isRegression =
        (existing.state === "merged" || existing.state === "closed") &&
        newState === "open";
      const nextState: ExternalRefState = isRegression ? existing.state! : newState;

      const stateChanged = existing.state !== nextState;
      await tx.update(schema.ticketExternalRefs)
        .set({
          title,
          state: nextState,
          polled_at: nowIso,
          polled_state_changed_at: stateChanged ? nowIso : existing.polled_state_changed_at,
        })
        .where(eq(schema.ticketExternalRefs.id, existing.id));

      if (stateChanged) {
        const summary = await loadTicketSummary(ticket, tx as any);
        await writeEvent(tx as any, {
          event_type: "ticket.external_ref_state_changed",
          actor: pollerUser ? mapUserRef(pollerUser) : null,
          ticket: summary,
          project_id: ticket.project_id,
          extras: {
            external_ref_id: existing.id,
            kind,
            url,
            prev_state: existing.state,
            new_state: nextState,
            source: "github_webhook",
          },
        });
      }
      updated++;
    });
  }
  return updated;
}
