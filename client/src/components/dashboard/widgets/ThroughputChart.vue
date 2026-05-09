<script setup lang="ts">
// Bar chart of closed tickets per period over the configured window.
// Reused on the Home dashboard, per-project Insights, and per-board Insights.

import { computed } from "vue";
import { useThroughput } from "@/composables/useDashboardData";
import Chart from "@/components/charts/Chart.vue";

const props = defineProps<{
  project?: string;          // optional CSV of project keys; default = all projects
  bucket?: "day" | "week";
  // 12 weeks weekly is what the homepage shows. Per-project might want shorter.
  weeks?: number;
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

const q = useThroughput(params);

const option = computed(() => {
  const points = q.data.value?.points ?? [];
  return {
    grid: { left: 32, right: 8, top: 12, bottom: 24 },
    xAxis: {
      type: "category",
      data: points.map((p) => formatBucketLabel(p.start, params.value.bucket ?? "week")),
      axisTick: { show: false },
    },
    yAxis: { type: "value", minInterval: 1 },
    tooltip: { trigger: "axis" },
    series: [{
      name: "Closed",
      type: "bar",
      data: points.map((p) => p.count),
      itemStyle: { borderRadius: [3, 3, 0, 0] },
      barMaxWidth: 28,
    }],
  };
});

const isEmpty = computed(() => (q.data.value?.points ?? []).every((p) => p.count === 0));

function formatBucketLabel(iso: string, bucket: "day" | "week"): string {
  const d = new Date(iso);
  if (bucket === "day") return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  // Show week-of label as the Monday's date.
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

defineExpose({ isEmpty });
</script>

<template>
  <Chart :option="option" :empty="isEmpty" height="220px" />
</template>
