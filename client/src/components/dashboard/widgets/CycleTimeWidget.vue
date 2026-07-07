<script setup lang="ts">
// Cycle-time widget. Headline is the median, with p90/p95 as supporting stats
// and a per-type breakdown bar. Powered by /v1/stats/cycle-time.

import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { useCycleTime } from "@/composables/useDashboardData";
import { formatDurationMs } from "@/lib/formatDuration";
import { useThemeStore } from "@/stores/theme";
import { cssVarRgb } from "@/lib/statusColors";
import Chart from "@/components/charts/Chart.vue";

const props = defineProps<{
  project?: string;
  weeks?: number;
  // Explicit window start (SWY-149 range control). Falls back to `weeks`.
  since?: string;
}>();

const params = computed(() => {
  let since = props.since;
  if (!since) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - (props.weeks ?? 12) * 7);
    since = d.toISOString();
  }
  return { project: props.project, since };
});

const q = useCycleTime(params);
const theme = useThemeStore();

const types = ["task", "bug", "spike", "epic"] as const;

// Per-type bar hues from the v4 family (design: task progress-blue, bug
// closed-green, spike planning-purple, epic signal-coral). The status hues
// are theme-aware (SWY-158) so they're read from the live vars inside the
// option computed — cssVarRgb is reactive; coral is shared and stays fixed.
function typeHex(t: (typeof types)[number]): string {
  return {
    task: cssVarRgb("--st-progress", "#64a0d6"),
    bug: cssVarRgb("--st-closed", "#63b58c"),
    spike: cssVarRgb("--st-planning", "#c08cd8"),
    epic: "#e2623d",
  }[t];
}

// Bumped on every html.class flip (Tailwind dark/light) so the bar-label
// color recomputes from the live CSS variable. Same MutationObserver
// pattern Chart.vue uses; we duplicate it here because the label color is
// part of the option object, not the wrapper theme.
const themeRev = ref(0);
let observer: MutationObserver | null = null;
onMounted(() => {
  observer = new MutationObserver(() => themeRev.value++);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
});
onBeforeUnmount(() => observer?.disconnect());

const labelColor = computed(() => {
  void themeRev.value;
  void theme.mode;
  if (typeof window === "undefined") return "#94a3b8";
  const v = getComputedStyle(document.documentElement)
    .getPropertyValue("--muted-foreground").trim();
  return v ? `hsl(${v})` : "#94a3b8";
});

const option = computed(() => {
  const data = q.data.value;
  return {
    // Generous right padding so the value labels at the bar tips have room
    // and don't visually press against the card edge. ECharts doesn't clip
    // bar labels to the grid, so the right margin has to absorb both the
    // longest possible label ("Nd Nh", ~5–6 chars) plus visual breathing
    // room — hence the 100px reservation.
    grid: { left: 72, right: 100, top: 8, bottom: 28 },
    xAxis: {
      type: "value",
      axisLabel: { formatter: (v: number) => formatDurationMs(v) },
    },
    yAxis: {
      type: "category",
      data: types.map((t) => t),
      axisTick: { show: false },
      axisLine: { show: false },
    },
    tooltip: {
      trigger: "axis",
      formatter: (params: any) => {
        const p = Array.isArray(params) ? params[0] : params;
        return `${p.name} · median ${formatDurationMs(p.value)}`;
      },
    },
    series: [{
      type: "bar",
      data: types.map((t) => ({
        value: data?.by_type?.[t]?.median_ms ?? 0,
        itemStyle: { color: typeHex(t) },
      })),
      barMaxWidth: 16,
      itemStyle: { borderRadius: [0, 3, 3, 0] },
      label: {
        show: true,
        position: "right",
        formatter: (p: any) => p.value > 0 ? formatDurationMs(p.value) : "",
        fontSize: 11,
        // ECharts auto-paints bar labels in the bar's color with a white
        // text-stroke for contrast — looks bad against our card backdrop.
        // Pin to the theme's muted-foreground (recomputes on theme flip
        // via the MutationObserver above) and drop the stroke.
        color: labelColor.value,
        textBorderWidth: 0,
      },
    }],
  };
});

const isEmpty = computed(() => !q.data.value || q.data.value.count === 0);
</script>

<template>
  <!--
    px-3 py-2 adds inset on top of CardContent's p-4, putting the stats row
    and the chart canvas ~28px from the card edges. The chart itself
    reserves additional grid margins for axis labels and bar value tags.
  -->
  <div class="space-y-4 px-3 py-2">
    <div v-if="q.isLoading.value" class="h-24" />
    <div v-else class="grid grid-cols-3 gap-6 text-sm">
      <div>
        <div class="text-[10px] uppercase tracking-wider text-muted-foreground">Median</div>
        <div class="font-semibold tabular-nums text-base">
          {{ formatDurationMs(q.data.value?.median_ms ?? 0) }}
        </div>
      </div>
      <div>
        <div class="text-[10px] uppercase tracking-wider text-muted-foreground">p90</div>
        <div class="font-semibold tabular-nums text-base">
          {{ formatDurationMs(q.data.value?.p90_ms ?? 0) }}
        </div>
      </div>
      <div>
        <div class="text-[10px] uppercase tracking-wider text-muted-foreground">p95</div>
        <div class="font-semibold tabular-nums text-base">
          {{ formatDurationMs(q.data.value?.p95_ms ?? 0) }}
        </div>
      </div>
    </div>
    <Chart
      :option="option"
      :empty="isEmpty"
      :loading="q.isLoading.value"
      height="180px"
    />
  </div>
</template>
