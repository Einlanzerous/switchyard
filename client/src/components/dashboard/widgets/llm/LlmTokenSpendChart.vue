<script setup lang="ts">
// Stacked-area chart of LLM spend ($) over weekly buckets, one stack per model.

import { computed } from "vue";
import { useLlmTokenSpend } from "@/composables/useLlmInsights";
import Chart from "@/components/charts/Chart.vue";

const props = defineProps<{
  project?: string;
  since?: string;
  until?: string;
  bucket?: "day" | "week";
}>();
const params = computed(() => ({
  project: props.project,
  since: props.since,
  until: props.until,
  bucket: props.bucket ?? "week",
}));
const q = useLlmTokenSpend(params);

function weekLabel(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

const option = computed(() => {
  const series = q.data.value?.series ?? [];
  const starts = [...new Set(series.flatMap((s) => s.points.map((p) => p.start)))].sort();
  return {
    grid: { left: 8, right: 16, top: 16, bottom: 56, containLabel: true },
    xAxis: { type: "category", data: starts.map(weekLabel), axisTick: { show: false } },
    yAxis: { type: "value", axisLabel: { formatter: (v: number) => `$${v}` } },
    tooltip: { trigger: "axis", valueFormatter: (v: number) => `$${v.toFixed(2)}` },
    legend: { bottom: 8, type: "scroll", icon: "circle", itemHeight: 8, padding: [4, 8] },
    series: series.map((s) => {
      const byStart = new Map(s.points.map((p) => [p.start, p.cost_usd]));
      return {
        name: s.model,
        type: "line",
        stack: "total",
        smooth: false, // straight segments — no bezier overshoot/bounce
        showSymbol: false,
        areaStyle: { opacity: 0.85 },
        data: starts.map((st) => byStart.get(st) ?? 0),
      };
    }),
  };
});

const isEmpty = computed(() => (q.data.value?.series ?? []).length === 0);
</script>

<template>
  <Chart :option="option" :empty="isEmpty" :loading="q.isLoading.value" height="320px" />
</template>
