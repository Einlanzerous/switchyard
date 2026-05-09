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

// ─── cumulative flow ───────────────────────────────────────────────────────
//
// A ticket's category at any timestamp T is determined by replaying its
// timeline:
//   - the ticket.created event sets the initial category
//   - each ticket.status_changed event overwrites it
//   - a ticket.deleted event removes the ticket from all subsequent buckets
//
// The CFD series counts, for each bucket boundary, how many tickets are
// "alive" (created and not deleted) and what category each is in.

export type TimelinePoint =
  | { kind: "init"; at: number; category: string }
  | { kind: "change"; at: number; category: string }
  | { kind: "delete"; at: number };

export type CategoryCountsLike = {
  backlog: number; planning: number; in_progress: number;
  blocked: number; closed: number;
};

const ZERO_COUNTS: CategoryCountsLike = {
  backlog: 0, planning: 0, in_progress: 0, blocked: 0, closed: 0,
};

const VALID_CATEGORIES = new Set(["backlog", "planning", "in_progress", "blocked", "closed"]);

// Walk a per-ticket timeline (sorted ascending by `at`) and return the
// category at time T, or null if the ticket isn't alive at T (created
// later, or deleted earlier).
export function categoryAt(timeline: TimelinePoint[], t: number): string | null {
  let category: string | null = null;
  let alive = false;
  for (const e of timeline) {
    if (e.at > t) break;
    if (e.kind === "init") { alive = true; category = e.category; }
    else if (e.kind === "change") { category = e.category; }
    else if (e.kind === "delete") { alive = false; category = null; }
  }
  return alive ? category : null;
}

// Build per-ticket sorted timelines from raw event payloads.
export function buildTimelines(rows: Array<{
  ticket_id: string | null;
  event_type: string;
  created_at: string;
  payload: unknown;
}>): Map<string, TimelinePoint[]> {
  const out = new Map<string, TimelinePoint[]>();
  for (const r of rows) {
    if (!r.ticket_id) continue;
    const at = Date.parse(r.created_at);
    const p = (r.payload ?? {}) as {
      ticket?: { status?: { category?: string } | null } | null;
      changes?: { status?: { to?: { category?: string } | null } | null };
    };
    const list = out.get(r.ticket_id) ?? [];
    if (r.event_type === "ticket.created") {
      const cat = p.ticket?.status?.category;
      if (cat && VALID_CATEGORIES.has(cat)) {
        list.push({ kind: "init", at, category: cat });
      }
    } else if (r.event_type === "ticket.status_changed") {
      const cat = p.changes?.status?.to?.category;
      if (cat && VALID_CATEGORIES.has(cat)) {
        list.push({ kind: "change", at, category: cat });
      }
    } else if (r.event_type === "ticket.deleted") {
      list.push({ kind: "delete", at });
    }
    out.set(r.ticket_id, list);
  }
  for (const list of out.values()) list.sort((a, b) => a.at - b.at);
  return out;
}

// Generate the bucket-end timestamps for [since, until] in `bucket` units.
// Each entry is the LAST millisecond of the bucket — that's the timestamp we
// evaluate ticket categories at, so a category change exactly at the close
// of a bucket is included in that bucket.
export function bucketEnds(since: Date, until: Date, bucket: "day" | "week"): number[] {
  const stepMs = (bucket === "day" ? 1 : 7) * 24 * 60 * 60 * 1000;
  // Snap `since` down to the start of its UTC day; weeks start on Monday
  // (ISO 8601). Postgres' date_trunc('week', …) does the same so the
  // throughput and CFD endpoints land on aligned boundaries.
  const startMs = bucket === "day"
    ? Date.UTC(since.getUTCFullYear(), since.getUTCMonth(), since.getUTCDate())
    : startOfIsoWeekUtc(since).getTime();
  const out: number[] = [];
  for (let t = startMs; t <= until.getTime(); t += stepMs) {
    out.push(t + stepMs - 1);
  }
  return out;
}

function startOfIsoWeekUtc(d: Date): Date {
  // ISO weeks start Monday; getUTCDay returns 0 = Sunday.
  const day = d.getUTCDay();
  const diff = day === 0 ? -6 : 1 - day; // shift back to Monday
  const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + diff));
  return monday;
}

export function computeCumulativeFlow(
  timelines: Map<string, TimelinePoint[]>,
  ends: number[]
): Array<{ end: string; by_category: CategoryCountsLike }> {
  const out: Array<{ end: string; by_category: CategoryCountsLike }> = [];
  for (const t of ends) {
    const counts: CategoryCountsLike = { ...ZERO_COUNTS };
    for (const tl of timelines.values()) {
      const cat = categoryAt(tl, t);
      if (cat && cat in counts) counts[cat as keyof CategoryCountsLike]++;
    }
    out.push({ end: new Date(t).toISOString(), by_category: counts });
  }
  return out;
}
