<script setup lang="ts">
// Cumulative-flow stacked area chart. Reads /v1/stats/cumulative-flow and
// renders one stacked series per status category. Powers the per-board
// burndown / CFD on the Insights tab.

import { computed } from "vue";
import { useCumulativeFlow } from "@/composables/useDashboardData";
import Chart from "@/components/charts/Chart.vue";

const props = defineProps<{
  project?: string;
  weeks?: number;
  bucket?: "day" | "week";
}>();

const params = computed(() => {
  const since = new Date();
  since.setUTCDate(since.getUTCDate() - (props.weeks ?? 12) * 7);
  return {
    project: props.project,
    since: since.toISOString(),
    bucket: props.bucket ?? "week",
  };
});

const q = useCumulativeFlow(params);

const CATS = ["backlog", "planning", "in_progress", "blocked", "closed"] as const;
const LABELS: Record<typeof CATS[number], string> = {
  backlog: "Backlog",
  planning: "Planning",
  in_progress: "In Progress",
  blocked: "Blocked",
  closed: "Closed",
};

const option = computed(() => {
  const points = q.data.value?.points ?? [];
  return {
    grid: { left: 32, right: 8, top: 24, bottom: 56 },
    legend: { bottom: 0, type: "scroll", icon: "circle", itemHeight: 8 },
    tooltip: { trigger: "axis" },
    xAxis: {
      type: "category",
      data: points.map((p) => formatBucketLabel(p.end, params.value.bucket ?? "week")),
      axisTick: { show: false },
    },
    yAxis: { type: "value", minInterval: 1 },
    series: CATS.map((c) => ({
      name: LABELS[c],
      type: "line",
      stack: "total",
      smooth: true,
      showSymbol: false,
      areaStyle: { opacity: 0.85 },
      lineStyle: { width: 0 },
      data: points.map((p) => p.by_category[c] ?? 0),
    })),
  };
});

const isEmpty = computed(() => {
  const points = q.data.value?.points ?? [];
  if (points.length === 0) return true;
  return points.every((p) => CATS.every((c) => (p.by_category[c] ?? 0) === 0));
});

function formatBucketLabel(iso: string, _bucket: "day" | "week"): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
</script>

<template>
  <Chart :option="option" :empty="isEmpty" height="280px" />
</template>
