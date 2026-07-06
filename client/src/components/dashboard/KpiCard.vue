<script setup lang="ts">
// Compact KPI card. Big number, label, optional delta badge, optional
// sub-line ("⚠ 3 stale"), optional sparkline. Used in the dashboard's
// top-row strip and inside Insights tabs.
//
// v4 additions:
// - `variant="accent"` — the coral-tinted "demands human action" card
//   (signal border + gradient wash, metric in the light coral).
// - `splitBar` — two-segment 6px machine/human bar (steel agents segment,
//   coral remainder) with a mono legend, for the "Agent share" card.
// - `to` — makes the whole card a router link (e.g. Needs-you → queue).
// - `#subline` slot for sublines that need markup (avatars, bold figures).

import { computed } from "vue";
import { RouterLink, type RouteLocationRaw } from "vue-router";
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
  // Optional short text shown to the RIGHT of the label (e.g. "164 calls",
  // "elevated") — keeps the card compact vs. a full subline row. `noteTone`
  // paints it in the warning color.
  note?: string | null;
  noteTone?: "default" | "warn";
  // Optional inline subline that paints in the destructive color — used for
  // the "⚠ N stale" warning on the in-progress card.
  warning?: string | null;
  // Y-values for the sparkline. Categories or x-values aren't needed; the
  // line is decorative, just shows shape.
  spark?: number[];
  loading?: boolean;
  variant?: "default" | "accent";
  // Two-segment machine/human bar. `leftPct` is the steel (agent) share;
  // the coral remainder is "you". Legend labels render underneath.
  splitBar?: { leftPct: number; leftLabel: string; rightLabel: string } | null;
  // When set the whole card navigates on click.
  to?: RouteLocationRaw;
}>();

// Coral signal accent (--signal). ECharts can't consume CSS vars, so the
// hex is inlined here the same way STATUS_HEX does it.
const SIGNAL_HEX = "#e2623d";

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
      lineStyle: { width: 1.5, color: SIGNAL_HEX },
      areaStyle: { opacity: 0.15, color: SIGNAL_HEX },
    }],
  };
});

const deltaColor = computed(() => {
  if (props.deltaPercent == null) return "";
  const goodUp = props.deltaGoodWhen !== "down";
  const isUp = props.deltaPercent > 0;
  if (props.deltaPercent === 0) return "text-muted-foreground";
  return (isUp === goodUp) ? "text-pos" : "text-neg";
});

const isAccent = computed(() => props.variant === "accent");
</script>

<template>
  <component
    :is="to ? RouterLink : 'div'"
    :to="to"
    :class="to ? 'block group cursor-pointer' : 'block'"
  >
    <Card
      class="h-full transition-colors"
      :class="[
        isAccent
          ? 'border-signal-line bg-gradient-to-b from-signal-weak to-transparent'
          : '',
        to ? 'group-hover:border-ink-4' : '',
      ]"
    >
      <CardContent class="p-4 flex flex-col gap-1.5">
        <div class="flex items-center justify-between gap-2">
          <span class="eyebrow">{{ label }}</span>
          <span
            v-if="note"
            class="text-[11px] tabular-nums shrink-0"
            :class="noteTone === 'warn' ? 'text-neg font-medium' : 'text-muted-foreground'"
          >{{ note }}</span>
        </div>

        <div v-if="loading" class="flex items-end gap-3">
          <Skeleton class="h-8 w-20" />
        </div>

        <div v-else class="flex items-end justify-between gap-3">
          <div class="flex items-baseline gap-2 min-w-0">
            <span class="metric" :class="isAccent ? 'text-signal-2' : ''">{{ value }}</span>
            <span
              v-if="deltaPercent !== undefined && deltaPercent !== null"
              class="delta inline-flex items-center"
              :class="deltaColor"
            >
              <ArrowUp v-if="deltaPercent > 0" class="h-3 w-3 mr-0.5" />
              <ArrowDown v-else-if="deltaPercent < 0" class="h-3 w-3 mr-0.5" />
              <Minus v-else class="h-3 w-3 mr-0.5" />
              {{ Math.round(Math.abs(deltaPercent) * 10) / 10 }}%
            </span>
          </div>
          <div v-if="spark && spark.length > 1" class="w-24 h-10 shrink-0">
            <Chart :option="sparkOption" height="100%" />
          </div>
        </div>

        <template v-if="splitBar && !loading">
          <div class="flex h-[6px] w-full overflow-hidden rounded-full bg-surface-4">
            <div
              class="h-full rounded-l-full bg-agent"
              :style="{ width: `${Math.min(100, Math.max(0, splitBar.leftPct))}%` }"
            />
            <div class="h-full flex-1 bg-signal" />
          </div>
          <div class="flex items-center justify-between font-mono text-[10px] text-ink-3">
            <span>{{ splitBar.leftLabel }}</span>
            <span>{{ splitBar.rightLabel }}</span>
          </div>
        </template>

        <div v-if="warning" class="text-[11px] font-medium text-neg">
          ⚠ {{ warning }}
        </div>
        <slot v-else-if="$slots.subline" name="subline" />
        <div
          v-else-if="subline"
          class="text-[11px]"
          :class="isAccent ? 'text-signal-2/80' : 'text-muted-foreground'"
        >
          {{ subline }}
        </div>
      </CardContent>
    </Card>
  </component>
</template>
