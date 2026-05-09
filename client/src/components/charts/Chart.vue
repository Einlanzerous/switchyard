<script setup lang="ts">
// Thin wrapper around vue-echarts. Centralizes:
//  - tree-shaken echarts module registration (line/bar/pie + the bits we use)
//  - theme reactivity tied to the html.dark class (Tailwind's dark mode)
//  - empty-state and fixed-height container
//
// Charts elsewhere just import this and pass an `option`. Theme colors are
// derived from CSS variables at render time, so a charts page reflects the
// current theme without any per-chart wiring.

import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import VChart from "vue-echarts";
import { use } from "echarts/core";
import { LineChart, BarChart, PieChart } from "echarts/charts";
import {
  GridComponent, TooltipComponent, TitleComponent, LegendComponent,
  DatasetComponent, TransformComponent, MarkLineComponent,
} from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import { LabelLayout, UniversalTransition } from "echarts/features";
import { useThemeStore } from "@/stores/theme";

use([
  CanvasRenderer,
  LineChart, BarChart, PieChart,
  GridComponent, TooltipComponent, TitleComponent, LegendComponent,
  DatasetComponent, TransformComponent, MarkLineComponent,
  LabelLayout, UniversalTransition,
]);

const props = defineProps<{
  option: any;
  height?: string;
  empty?: boolean;
}>();

const theme = useThemeStore();

// Read an HSL CSS variable and return as `hsl(...)` so ECharts can use it.
function readCss(name: string, fallback = "#000"): string {
  if (typeof window === "undefined") return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v ? `hsl(${v})` : fallback;
}

// Bumped whenever html.class changes (Tailwind dark/light flip). Kept as a
// separate ref so the computed theme depends on it; the MutationObserver
// below increments it.
const themeRev = ref(0);

const PALETTE = [
  "#3b82f6", // blue 500
  "#22c55e", // green
  "#f59e0b", // amber
  "#ef4444", // red
  "#8b5cf6", // violet
  "#06b6d4", // cyan
  "#ec4899", // pink
  "#84cc16", // lime
];

const echartsTheme = computed(() => {
  // Reading reactive sources establishes the dependency.
  void themeRev.value;
  void theme.mode;
  const fg = readCss("--foreground");
  const muted = readCss("--muted-foreground");
  const border = readCss("--border");
  const popover = readCss("--popover");
  const popoverFg = readCss("--popover-foreground");
  return {
    color: PALETTE,
    backgroundColor: "transparent",
    textStyle: { color: muted, fontFamily: "inherit" },
    title: { textStyle: { color: fg, fontWeight: 500 } },
    legend: { textStyle: { color: muted } },
    tooltip: {
      backgroundColor: popover,
      borderColor: border,
      textStyle: { color: popoverFg },
      extraCssText: "box-shadow: 0 4px 12px rgba(0,0,0,0.08);",
    },
    categoryAxis: {
      axisLine: { lineStyle: { color: border } },
      axisTick: { lineStyle: { color: border } },
      axisLabel: { color: muted },
      splitLine: { show: false },
    },
    valueAxis: {
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { color: muted },
      splitLine: { lineStyle: { color: border, opacity: 0.4 } },
    },
  };
});

// Watch html.class so theme cycles through `auto` (which doesn't tick the
// pinia mode) still re-render the chart.
let observer: MutationObserver | null = null;
onMounted(() => {
  observer = new MutationObserver(() => themeRev.value++);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class"],
  });
});
onBeforeUnmount(() => observer?.disconnect());
watch(() => theme.mode, () => themeRev.value++);
</script>

<template>
  <div class="relative w-full" :style="{ height: props.height ?? '240px' }">
    <div
      v-if="props.empty"
      class="absolute inset-0 flex items-center justify-center text-xs text-muted-foreground italic"
    >
      No data yet.
    </div>
    <VChart
      v-else
      :option="props.option"
      :theme="echartsTheme"
      autoresize
      class="w-full h-full"
    />
  </div>
</template>
