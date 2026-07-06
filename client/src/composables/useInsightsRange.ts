// Shared time-range state for the Board/Project Insights pages (SWY-149).
//
// Unlike useLlmWindow (per-call refs), the selection is a MODULE-LEVEL
// singleton: swapping Board ↔ Insights unmounts the view, and the choice has
// to survive that within the session. The composable also mirrors the
// selection into `?range=` so insights URLs deep-link, and re-adopts a valid
// URL value on setup (a shared link wins over the singleton).

import { ref, computed, watch } from "vue";
import { useRoute, useRouter } from "vue-router";

export const INSIGHTS_RANGES = [
  { key: "7d", label: "7D", buckets: 7, bucket: "day" },
  { key: "12w", label: "12W", buckets: 12, bucket: "week" },
  { key: "1y", label: "1Y", buckets: 52, bucket: "week" },
] as const;

export type InsightsRangeKey = (typeof INSIGHTS_RANGES)[number]["key"];

export function isInsightsRangeKey(v: unknown): v is InsightsRangeKey {
  return INSIGHTS_RANGES.some((r) => r.key === v);
}

const DAY_MS = 86_400_000;

const rangeKey = ref<InsightsRangeKey>("12w");

function rangeDef(key: InsightsRangeKey) {
  return INSIGHTS_RANGES.find((r) => r.key === key)!;
}

// UTC start of the bucket containing `ms`. Weeks are ISO weeks (Monday
// start) — the same boundary Postgres date_trunc('week') uses server-side.
export function truncUtc(ms: number, bucket: "day" | "week"): number {
  const d = new Date(ms);
  const dayStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  if (bucket === "day") return dayStart;
  const mondayOffset = (d.getUTCDay() + 6) % 7;
  return dayStart - mondayOffset * DAY_MS;
}

export function useInsightsRange() {
  const route = useRoute();
  const router = useRouter();

  const fromUrl = route.query.range;
  if (isInsightsRangeKey(fromUrl)) rangeKey.value = fromUrl;

  // `immediate` writes the singleton back onto URLs that arrived without a
  // range param (tab swaps push bare paths).
  watch(
    rangeKey,
    (k) => {
      if (route.query.range !== k) {
        void router.replace({ query: { ...route.query, range: k } });
      }
    },
    { immediate: true },
  );

  // Bucket-aligned window start: exactly `buckets` buckets including the
  // current (partial) one. Aligned + truncated so the ISO string only changes
  // when a day/week rolls over — an untruncated `new Date()` would mint a
  // fresh TanStack key on every remount and refetch the whole page.
  const since = computed(() => {
    const def = rangeDef(rangeKey.value);
    const step = def.bucket === "day" ? DAY_MS : 7 * DAY_MS;
    return new Date(truncUtc(Date.now(), def.bucket) - (def.buckets - 1) * step).toISOString();
  });

  const bucket = computed<"day" | "week">(() => rangeDef(rangeKey.value).bucket);
  const windowLabel = computed(() => rangeKey.value as string);
  const perLabel = computed(() => (bucket.value === "day" ? "closed / day" : "closed / week"));

  return { rangeKey, since, bucket, windowLabel, perLabel };
}
