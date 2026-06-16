// Shared time-window state for the LLM Insights surfaces. The selector lives in
// each view's header; the derived range/bucket/label flow down into the body.

import { ref, computed } from "vue";

export const LLM_WINDOWS = [
  { d: 1, l: "1D" },
  { d: 3, l: "3D" },
  { d: 7, l: "7D" },
  { d: 30, l: "1M" },
] as const;

export function useLlmWindow(defaultDays = 7) {
  const windowDays = ref(defaultDays);
  const range = computed(() => {
    const until = new Date();
    const since = new Date(until.getTime() - windowDays.value * 86_400_000);
    return { since: since.toISOString(), until: until.toISOString() };
  });
  // Short windows read better as daily buckets; a month rolls up to weeks.
  const bucket = computed<"day" | "week">(() => (windowDays.value <= 7 ? "day" : "week"));
  const windowLabel = computed(() => LLM_WINDOWS.find((w) => w.d === windowDays.value)?.l ?? `${windowDays.value}D`);
  return { windowDays, range, bucket, windowLabel };
}
