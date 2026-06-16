<script setup lang="ts">
// Error rate over time as a STACKED bar: each bar = that bucket's error rate %,
// split into segments per error code (distinct colors). Hover shows each code's
// contribution. Headline states the overall rate in plain words.

import { computed } from "vue";
import { useLlmErrorRate } from "@/composables/useLlmInsights";
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
const q = useLlmErrorRate(params);
const data = computed(() => q.data.value);

// Distinct (warm) colors per code so they're tellable apart, not a wall of red.
const CODE_COLORS = ["#ef4444", "#f97316", "#f59e0b", "#ec4899", "#a855f7", "#14b8a6"];

function bucketLabel(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

const option = computed(() => {
  const codes = data.value?.codes ?? [];
  const points = data.value?.points ?? [];
  return {
    grid: { left: 8, right: 16, top: 16, bottom: 36, containLabel: true },
    xAxis: { type: "category", data: points.map((p) => bucketLabel(p.start)), axisTick: { show: false } },
    yAxis: { type: "value", axisLabel: { formatter: (v: number) => `${v}%` } },
    tooltip: { trigger: "axis", valueFormatter: (v: number) => `${(+v).toFixed(1)}%` },
    legend: { bottom: 0, type: "scroll", icon: "circle", itemHeight: 8 },
    series: codes.map((code, i) => ({
      name: code,
      type: "bar",
      stack: "err",
      barMaxWidth: 28,
      itemStyle: { color: CODE_COLORS[i % CODE_COLORS.length] },
      data: points.map((p) => (p.call_count > 0 ? ((p.by_code[code] ?? 0) / p.call_count) * 100 : 0)),
    })),
  };
});

const isEmpty = computed(() => (data.value?.points ?? []).every((p) => p.call_count === 0));
</script>

<template>
  <Chart :option="option" :empty="isEmpty" :loading="q.isLoading.value" height="240px" />
</template>
