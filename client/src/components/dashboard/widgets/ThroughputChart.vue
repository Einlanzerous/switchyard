<script setup lang="ts">
// Stacked closed-per-period bars (SWY-150): agent closures (steel) as the
// base with the human's (coral) capping each bar — the "throughput split by
// agent vs you" headline chart on both Insights views. Buckets are
// zero-filled client-side so quiet days/weeks render as gaps in the series,
// not missing categories.

import { computed } from "vue";
import { useThroughput } from "@/composables/useDashboardData";
import { fillThroughputBuckets } from "@/lib/statsBuckets";
import { cssVarRgb } from "@/lib/statusColors";
import Chart from "@/components/charts/Chart.vue";

// Coral is theme-shared so it stays a constant; agent steel flips with the
// theme and is read from the live var inside the option computed (SWY-158).
const SIGNAL_HEX = "#e2623d";

const props = defineProps<{
  project?: string;          // optional CSV of project keys; default = all projects
  bucket?: "day" | "week";
  // Explicit window start (SWY-149 range control). Falls back to `weeks`.
  since?: string;
  weeks?: number;
}>();

const params = computed(() => {
  let since = props.since;
  if (!since) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - (props.weeks ?? 12) * 7);
    since = d.toISOString();
  }
  return {
    project: props.project,
    since,
    bucket: props.bucket ?? "week",
  };
});

const q = useThroughput(params);

const filled = computed(() =>
  fillThroughputBuckets(
    q.data.value?.points ?? [],
    params.value.since,
    params.value.bucket ?? "week",
  ),
);

const option = computed(() => {
  const points = filled.value;
  const bucket = params.value.bucket ?? "week";
  return {
    grid: { left: 32, right: 8, top: 12, bottom: 24 },
    xAxis: {
      type: "category",
      data: points.map((p) => formatBucketLabel(p.start)),
      axisTick: { show: false },
      // 1Y = 52 weekly labels; let ECharts thin them instead of overlapping.
      axisLabel: { hideOverlap: true },
    },
    yAxis: { type: "value", minInterval: 1 },
    tooltip: {
      trigger: "axis",
      formatter: (ps: unknown) => {
        const arr = Array.isArray(ps) ? ps : [ps];
        const val = (name: string) =>
          Number((arr as any[]).find((p) => p.seriesName === name)?.value ?? 0);
        const agents = val("agents");
        const you = val("you");
        const label = (arr as any[])[0]?.name ?? "";
        return `${label}<br/>agents&nbsp;${agents} · you&nbsp;${you}<br/>total&nbsp;${agents + you}`;
      },
    },
    series: [
      {
        name: "agents",
        type: "bar",
        stack: "split",
        barMaxWidth: 28,
        data: points.map((p) => ({
          value: p.agent_count,
          // The agent segment only gets the rounded top when it IS the top
          // (no human cap that bucket).
          itemStyle: {
            color: cssVarRgb("--agent", "#8fa6bd"),
            borderRadius: p.human_count === 0 ? [3, 3, 0, 0] : [0, 0, 0, 0],
          },
        })),
      },
      {
        name: "you",
        type: "bar",
        stack: "split",
        barMaxWidth: 28,
        itemStyle: { color: SIGNAL_HEX, borderRadius: [3, 3, 0, 0] },
        data: points.map((p) => p.human_count),
      },
    ],
  };
});

const isEmpty = computed(() => filled.value.every((p) => p.count === 0));

function formatBucketLabel(iso: string): string {
  // Weeks label as their Monday's date; days as the date itself.
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

defineExpose({ isEmpty });
</script>

<template>
  <Chart
    :option="option"
    :empty="isEmpty"
    :loading="q.isLoading.value"
    height="220px"
  />
</template>
