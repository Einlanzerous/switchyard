// Pure functions powering the cycle-time endpoint.
//
// We replay the per-ticket sequence of `ticket.status_changed` events to
// compute time spent specifically in the `in_progress` category. Time spent
// in `blocked` or any other category is intentionally NOT included — that's
// a separate metric (locked decision in the Phase 3 plan).
//
// All math is millisecond integers. Percentile uses the same simple
// nearest-rank rule used elsewhere in the app, so server- and client-side
// implementations agree.

import type { TicketType, CycleTimeSample, CycleTimeStats } from "@switchyard/shared";

export type StatusChangeRow = {
  ticket_id: string;
  created_at: string;
  from_category: string | null;
  to_category: string;
};

export type ClosedTicketInfo = {
  ticket_id: string;
  ticket_key: string;
  type: TicketType;
  closed_at: string;
};

// Walk one ticket's status-change timeline and sum the time it spent in
// in_progress. Open ranges (entered in_progress and never recorded leaving)
// are dropped — that means the ticket is still in_progress and shouldn't
// have ended up in the "closed in window" set anyway.
export function computeInProgressMs(events: StatusChangeRow[]): number {
  // Defensive sort — caller probably already sorted but be safe.
  const evs = events.slice().sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
  let totalMs = 0;
  let enteredAt: number | null = null;
  for (const e of evs) {
    const t = Date.parse(e.created_at);
    // Entered in_progress (and not already inside it).
    if (e.to_category === "in_progress" && enteredAt === null) {
      enteredAt = t;
      continue;
    }
    // Left in_progress (only count if we have an entry recorded).
    if (e.from_category === "in_progress" && enteredAt !== null) {
      totalMs += t - enteredAt;
      enteredAt = null;
    }
  }
  return totalMs;
}

export function buildCycleTimeSamples(
  closed: Map<string, ClosedTicketInfo>,
  eventsByTicket: Map<string, StatusChangeRow[]>
): CycleTimeSample[] {
  const out: CycleTimeSample[] = [];
  for (const [ticketId, info] of closed) {
    const ms = computeInProgressMs(eventsByTicket.get(ticketId) ?? []);
    if (ms <= 0) continue; // Tickets that closed without ever entering in_progress don't contribute.
    out.push({
      ticket_id: ticketId,
      ticket_key: info.ticket_key,
      type: info.type,
      duration_ms: ms,
      closed_at: info.closed_at,
    });
  }
  return out;
}

// Nearest-rank percentile. p in [0, 1]. Empty input → 0.
export function percentile(sortedMs: number[], p: number): number {
  if (sortedMs.length === 0) return 0;
  const idx = Math.min(sortedMs.length - 1, Math.max(0, Math.ceil(sortedMs.length * p) - 1));
  return sortedMs[idx]!;
}

export function summarizeCycleTime(samples: CycleTimeSample[]): CycleTimeStats {
  const byType: Record<TicketType, number[]> = { task: [], bug: [], spike: [], epic: [] };
  const all: number[] = [];
  for (const s of samples) {
    all.push(s.duration_ms);
    byType[s.type].push(s.duration_ms);
  }
  all.sort((a, b) => a - b);
  for (const k of Object.keys(byType) as TicketType[]) byType[k].sort((a, b) => a - b);

  const median = percentile(all, 0.5);
  return {
    count: all.length,
    median_ms: median,
    p50_ms: median,
    p90_ms: percentile(all, 0.9),
    p95_ms: percentile(all, 0.95),
    by_type: {
      task: { median_ms: percentile(byType.task, 0.5), count: byType.task.length },
      bug: { median_ms: percentile(byType.bug, 0.5), count: byType.bug.length },
      spike: { median_ms: percentile(byType.spike, 0.5), count: byType.spike.length },
      epic: { median_ms: percentile(byType.epic, 0.5), count: byType.epic.length },
    },
  };
}

// Resolve the [since, until] window. Defaults: since = 12 weeks ago,
// until = now. Both are inclusive on the SQL side.
export function resolveWindow(input: { since?: string; until?: string }): { since: Date; until: Date } {
  const until = input.until ? new Date(input.until) : new Date();
  const since = input.since
    ? new Date(input.since)
    : new Date(until.getTime() - 12 * 7 * 24 * 60 * 60 * 1000);
  return { since, until };
}
