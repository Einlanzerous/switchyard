<script setup lang="ts">
// Compact KPI card. Big number, label, optional delta badge, optional
// sub-line ("⚠ 3 stale"), optional sparkline. Used in the dashboard's
// top-row strip and inside Insights tabs.

import { computed } from "vue";
import { ArrowUp, ArrowDown, Minus } from "lucide-vue-next";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import Chart from "@/components/charts/Chart.vue";

const props = defineProps<{
  label: string;
  value: string | number;
  // Delta vs prior period. Sign is significant: positive means up. We show
  // the percent and the direction; the consumer decides whether up is good
  // (throughput) or bad (cycle time) via `deltaGoodWhen`.
  deltaPercent?: number | null;
  deltaGoodWhen?: "up" | "down";
  subline?: string;
  // Optional inline subline that paints in the destructive color — used for
  // the "⚠ N stale" warning on the in-progress card.
  warning?: string | null;
  // Y-values for the sparkline. Categories or x-values aren't needed; the
  // line is decorative, just shows shape.
  spark?: number[];
  loading?: boolean;
}>();

const sparkOption = computed(() => {
  const data = props.spark ?? [];
  return {
    grid: { left: 0, right: 0, top: 4, bottom: 4 },
    xAxis: { type: "category", show: false, data: data.map((_, i) => i) },
    yAxis: { type: "value", show: false },
    tooltip: { show: false },
    series: [{
      type: "line",
      data,
      smooth: true,
      showSymbol: false,
      lineStyle: { width: 1.5 },
      areaStyle: { opacity: 0.2 },
    }],
  };
});

const deltaColor = computed(() => {
  if (props.deltaPercent == null) return "";
  const goodUp = props.deltaGoodWhen !== "down";
  const isUp = props.deltaPercent > 0;
  if (props.deltaPercent === 0) return "text-muted-foreground";
  return (isUp === goodUp) ? "text-emerald-600 dark:text-emerald-500" : "text-rose-600 dark:text-rose-500";
});
</script>

<template>
  <Card>
    <CardContent class="p-4 flex flex-col gap-1.5">
      <div class="text-[11px] uppercase tracking-wider text-muted-foreground font-medium">
        {{ label }}
      </div>

      <div v-if="loading" class="flex items-end gap-3">
        <Skeleton class="h-8 w-20" />
      </div>

      <div v-else class="flex items-end justify-between gap-3">
        <div class="flex items-baseline gap-2 min-w-0">
          <span class="text-2xl font-semibold tracking-tight tabular-nums">{{ value }}</span>
          <span
            v-if="deltaPercent !== undefined && deltaPercent !== null"
            class="inline-flex items-center text-[11px] font-medium tabular-nums"
            :class="deltaColor"
          >
            <ArrowUp v-if="deltaPercent > 0" class="h-3 w-3 mr-0.5" />
            <ArrowDown v-else-if="deltaPercent < 0" class="h-3 w-3 mr-0.5" />
            <Minus v-else class="h-3 w-3 mr-0.5" />
            {{ Math.abs(deltaPercent) }}%
          </span>
        </div>
        <div v-if="spark && spark.length > 1" class="w-24 h-10 shrink-0">
          <Chart :option="sparkOption" height="100%" />
        </div>
      </div>

      <div v-if="warning" class="text-[11px] font-medium text-rose-600 dark:text-rose-500">
        ⚠ {{ warning }}
      </div>
      <div v-else-if="subline" class="text-[11px] text-muted-foreground">
        {{ subline }}
      </div>
    </CardContent>
  </Card>
</template>
