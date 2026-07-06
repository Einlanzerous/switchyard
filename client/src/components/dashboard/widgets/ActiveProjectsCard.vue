<script setup lang="ts">
// "Active projects" dashboard card (SWY-141): every project ranked by
// recent activity — 14d pulse sparkline, open count, status-distribution
// bar, recent drivers, last-touched time. Projects with zero events in the
// pulse window collapse to dimmed rows under a "Quiet" divider.
//
// Pulse trend → stroke color:
//   dormant  — no events in the 14d window → row moves below the divider
//   stalled  — has 14d traffic but nothing within EPIC_STALL_AFTER_DAYS
//              → blocked-red stroke + "stalled" chip (the declining/old case)
//   flat     — a trickle (≤3 events in 14d) → backlog-gray
//   rising   — last 7 days ≥ 1.25× the prior 7 → closed-green
//   steady   — everything else → progress-blue

import { computed } from "vue";
import { useRouter } from "vue-router";
import { useQuery } from "@tanstack/vue-query";
import { FolderOpen } from "lucide-vue-next";
import { EPIC_STALL_AFTER_DAYS } from "@switchyard/shared";
import { api } from "@/lib/api";
import { queryKeys } from "@/lib/queryKeys";
import { formatCompactRelativeTime } from "@/lib/formatTime";
import { STATUS_HEX } from "@/lib/statusColors";
import { useActivityPulse } from "@/composables/useDashboardData";
import DashboardWidget from "@/components/dashboard/DashboardWidget.vue";
import UserAvatar from "@/components/UserAvatar.vue";

const router = useRouter();

const pulseQ = useActivityPulse();

// by_category proportions for the status bar (bulk stats feed).
const statsQ = useQuery({
  queryKey: queryKeys.statsProjects(),
  staleTime: 60 * 1000,
  queryFn: async () => {
    const { data, error } = await api.GET("/v1/stats/projects");
    if (error) throw error;
    return data;
  },
});

// Project descriptions live on the full catalog, not on ProjectRef.
const projectsQ = useQuery({
  queryKey: queryKeys.projects(),
  staleTime: 60 * 1000,
  queryFn: async () => {
    const { data, error } = await api.GET("/v1/projects");
    if (error) throw error;
    return data;
  },
});

const isLoading = computed(() => pulseQ.isLoading.value || statsQ.isLoading.value);
const error = computed(() => pulseQ.error.value ?? statsQ.error.value);

type Trend = "stalled" | "flat" | "rising" | "steady";

const TREND_HEX: Record<Trend, string> = {
  rising: STATUS_HEX.closed,
  steady: STATUS_HEX.in_progress,
  flat: STATUS_HEX.backlog,
  stalled: STATUS_HEX.blocked,
};

const STATUS_BAR_ORDER = ["backlog", "planning", "in_progress", "blocked", "closed"] as const;

function trendOf(series: number[], lastActivityAt: string | null): Trend {
  const total = series.reduce((a, n) => a + n, 0);
  const ageDays = lastActivityAt
    ? (Date.now() - new Date(lastActivityAt).getTime()) / 86_400_000
    : Infinity;
  if (ageDays >= EPIC_STALL_AFTER_DAYS) return "stalled";
  if (total <= 3) return "flat";
  const half = Math.floor(series.length / 2);
  const first = series.slice(0, half).reduce((a, n) => a + n, 0);
  const second = series.slice(half).reduce((a, n) => a + n, 0);
  if (second >= Math.max(1, first) * 1.25) return "rising";
  return "steady";
}

// 88×26 polyline, 2px inset; y normalized to the series max.
function sparkPoints(series: number[]): string {
  const w = 88, h = 26, pad = 2;
  const max = Math.max(...series, 1);
  const stepX = (w - pad * 2) / Math.max(series.length - 1, 1);
  return series
    .map((n, i) => `${(pad + i * stepX).toFixed(1)},${(h - pad - (n / max) * (h - pad * 2)).toFixed(1)}`)
    .join(" ");
}

const rows = computed(() => {
  const statsByKey = new Map(
    (statsQ.data.value?.items ?? []).map((r) => [r.project.key, r])
  );
  const descByKey = new Map(
    (projectsQ.data.value?.items ?? []).map((p) => [p.key, p.description ?? null])
  );
  return (pulseQ.data.value?.items ?? []).map((r) => {
    const stats = statsByKey.get(r.project.key);
    const byCategory = stats?.by_category;
    const total = byCategory
      ? STATUS_BAR_ORDER.reduce((a, c) => a + byCategory[c], 0)
      : 0;
    const dormant = r.activity_series.every((n) => n === 0);
    const trend = trendOf(r.activity_series, r.last_activity_at);
    return {
      project: r.project,
      description: descByKey.get(r.project.key),
      series: r.activity_series,
      actors: r.recent_actors.slice(0, 2),
      lastActivityAt: r.last_activity_at,
      open: stats?.totals.open ?? 0,
      segments: byCategory && total > 0
        ? STATUS_BAR_ORDER
            .filter((c) => byCategory[c] > 0)
            .map((c) => ({ category: c, pct: (byCategory[c] / total) * 100 }))
        : [],
      dormant,
      trend,
      trendHex: TREND_HEX[trend],
      points: sparkPoints(r.activity_series),
    };
  });
});

const active = computed(() =>
  rows.value
    .filter((r) => !r.dormant)
    .sort((a, b) => (b.lastActivityAt ?? "").localeCompare(a.lastActivityAt ?? ""))
);
const dormant = computed(() =>
  rows.value
    .filter((r) => r.dormant)
    .sort((a, b) => (b.lastActivityAt ?? "").localeCompare(a.lastActivityAt ?? ""))
);

function quietFor(lastActivityAt: string | null): string {
  if (!lastActivityAt) return "quiet";
  return `quiet ${formatCompactRelativeTime(lastActivityAt)}`;
}

function open(key: string) {
  router.push(`/projects/${key}/board`);
}
</script>

<template>
  <DashboardWidget title="Active projects" :loading="isLoading" :error="error" :padded="false">
    <template #title-prefix>
      <FolderOpen class="h-3.5 w-3.5 text-muted-foreground" />
    </template>
    <template #title-suffix>
      <span class="ml-1 font-mono text-[10px] text-ink-3">by recent activity</span>
    </template>
    <template #actions>
      <span class="eyebrow">14d pulse</span>
    </template>

    <div v-if="rows.length === 0" class="py-8 text-center text-xs text-muted-foreground">
      No projects yet.
    </div>

    <ul v-else class="divide-y divide-border/60">
      <li
        v-for="r in active"
        :key="r.project.id"
        class="flex items-center gap-3 px-4 py-2.5 cursor-pointer hover:bg-accent/40 transition-colors"
        @click="open(r.project.key)"
      >
        <span
          class="w-12 shrink-0 font-mono text-[11.5px] font-semibold"
          :style="{ color: r.project.color ?? undefined }"
        >{{ r.project.key }}</span>

        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-2">
            <span class="text-[13px] font-medium truncate">{{ r.project.name }}</span>
            <span
              v-if="r.trend === 'stalled'"
              class="shrink-0 rounded bg-signal-weak px-1.5 py-px font-mono text-[9px] uppercase tracking-wider text-signal-2"
            >stalled</span>
          </div>
          <!-- Wraps to a second line rather than running the row wide;
               anything longer clamps. -->
          <div v-if="r.description" class="text-[11px] leading-snug text-ink-3 line-clamp-2">
            {{ r.description }}
          </div>
        </div>

        <svg class="shrink-0" width="88" height="26" viewBox="0 0 88 26" aria-hidden="true">
          <polyline
            :points="r.points"
            fill="none"
            :stroke="r.trendHex"
            stroke-width="1.5"
            stroke-linejoin="round"
            stroke-linecap="round"
          />
        </svg>

        <div class="w-14 shrink-0 text-right">
          <span class="metric-sm">{{ r.open }}</span>
          <span class="ml-1 text-[10px] text-ink-3">open</span>
        </div>

        <div class="hidden sm:flex h-[5px] w-16 shrink-0 overflow-hidden rounded-full bg-surface-4">
          <div
            v-for="seg in r.segments"
            :key="seg.category"
            class="h-full"
            :style="{ width: `${seg.pct}%`, backgroundColor: STATUS_HEX[seg.category] }"
          />
        </div>

        <div class="hidden sm:flex w-12 shrink-0 -space-x-1 justify-end">
          <UserAvatar
            v-for="a in r.actors"
            :key="a.id"
            :user="a"
            size="xs"
            class="ring-1 ring-background"
          />
        </div>

        <span class="w-9 shrink-0 text-right font-mono text-[10.5px] text-ink-3 tabular-nums">
          {{ formatCompactRelativeTime(r.lastActivityAt) }}
        </span>
      </li>

      <li v-if="dormant.length > 0" class="flex items-center gap-3 px-4 py-2" aria-hidden="true">
        <span class="h-px flex-1 bg-border" />
        <span class="eyebrow">Quiet — no recent traffic</span>
        <span class="h-px flex-1 bg-border" />
      </li>

      <li
        v-for="r in dormant"
        :key="r.project.id"
        class="flex items-center gap-3 px-4 py-2 opacity-55 cursor-pointer hover:opacity-80 hover:bg-accent/40 transition"
        @click="open(r.project.key)"
      >
        <span
          class="w-12 shrink-0 font-mono text-[11.5px] font-semibold"
          :style="{ color: r.project.color ?? undefined }"
        >{{ r.project.key }}</span>
        <!-- Both spans must be block-level for truncate to clip; inline spans
             overflow the row instead and push the card past its column. -->
        <div class="flex flex-1 min-w-0 items-baseline gap-2">
          <span class="shrink-0 text-[13px] font-medium">{{ r.project.name }}</span>
          <span v-if="r.description" class="min-w-0 truncate text-[11px] text-ink-3">{{ r.description }}</span>
        </div>
        <span class="shrink-0 rounded bg-surface-4 px-1.5 py-px font-mono text-[9.5px] text-ink-3">
          {{ quietFor(r.lastActivityAt) }}
        </span>
        <div class="w-14 shrink-0 text-right">
          <span class="text-[13px] font-semibold tabular-nums">{{ r.open }}</span>
          <span class="ml-1 text-[10px] text-ink-3">open</span>
        </div>
      </li>
    </ul>
  </DashboardWidget>
</template>
