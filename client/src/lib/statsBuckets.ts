// Client-side zero-fill for the throughput series (SWY-149/150).
//
// /v1/stats/throughput is a bare GROUP BY date_trunc — buckets with no
// closures are simply missing from `points`. That's fine for a dense 12-week
// board but wrong for a 7-day daily chart, where a quiet Tuesday must render
// as a zero bar, not vanish. Buckets are generated with the same UTC-day /
// ISO-Monday boundaries as Postgres date_trunc.

import { truncUtc } from "@/composables/useInsightsRange";

const DAY_MS = 86_400_000;

export interface ThroughputPointLike {
  start: string;
  count: number;
  agent_count: number;
  human_count: number;
}

// Hard stop far above the widest real window (1Y weekly = 52, 7D daily = 7);
// protects against a malformed `since` producing a runaway loop.
const MAX_BUCKETS = 400;

export function fillThroughputBuckets(
  points: ThroughputPointLike[],
  sinceIso: string,
  bucket: "day" | "week",
): ThroughputPointLike[] {
  const sinceMs = Date.parse(sinceIso);
  if (Number.isNaN(sinceMs)) return points;

  const step = bucket === "day" ? DAY_MS : 7 * DAY_MS;
  const first = truncUtc(sinceMs, bucket);
  const last = truncUtc(Date.now(), bucket);
  if (last < first || (last - first) / step >= MAX_BUCKETS) return points;

  const byStart = new Map(points.map((p) => [truncUtc(Date.parse(p.start), bucket), p]));
  const out: ThroughputPointLike[] = [];
  for (let t = first; t <= last; t += step) {
    out.push(
      byStart.get(t) ?? {
        start: new Date(t).toISOString(),
        count: 0,
        agent_count: 0,
        human_count: 0,
      },
    );
  }
  return out;
}
