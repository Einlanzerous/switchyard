<script setup lang="ts">
// Personal at-a-glance landing page.
//
// Layout (12-col grid, collapses to single column on small screens):
//   row 1 — KPI strip (4 cards): open / in-progress / closed-this-week / cycle time
//   row 2 — how are we doing: throughput (6) + status donut (6)
//   row 3 — what's happening: recent activity (full width)
//   row 4 — stale work (full width, only when there's something stale)
//
// Per-user noise (my open tickets, @mentions) deliberately lives off the
// dashboard: open tickets are one click away via the profile menu's
// "My tickets" link, and @mentions surface in the notification bell.
//
// Each widget owns its own data fetching so a slow query can't blank the
// whole dashboard. Skeleton state is per-widget.

import { computed } from "vue";
import { useQuery } from "@tanstack/vue-query";
import { Activity, Clock, BarChart2, PieChart, ClipboardCheck } from "lucide-vue-next";
import { useAuthStore } from "@/stores/auth";
import { api } from "@/lib/api";
import { queryKeys } from "@/lib/queryKeys";
import { useThroughput, useStaleRollup } from "@/composables/useDashboardData";
import { formatDurationMs, formatDeltaPercent } from "@/lib/formatDuration";
import KpiCard from "@/components/dashboard/KpiCard.vue";
import DashboardWidget from "@/components/dashboard/DashboardWidget.vue";
import ActivityFeed from "@/components/dashboard/widgets/ActivityFeed.vue";
import PlansAwaitingReview from "@/components/dashboard/widgets/PlansAwaitingReview.vue";
import StaleRollupWidget from "@/components/dashboard/widgets/StaleRollup.vue";
import ThroughputChart from "@/components/dashboard/widgets/ThroughputChart.vue";
import StatusDonut from "@/components/dashboard/widgets/StatusDonut.vue";

const auth = useAuthStore();

// ─── KPI feeds ───────────────────────────────────────────────────────────────

// Aggregate totals/by_category across all projects via the bulk stats feed.
const projectsStats = useQuery({
  queryKey: queryKeys.statsProjects(),
  staleTime: 60 * 1000,
  queryFn: async () => {
    const { data, error } = await api.GET("/v1/stats/projects");
    if (error) throw error;
    return data;
  },
});

const totals = computed(() => {
  const items = projectsStats.data.value?.items ?? [];
  return items.reduce(
    (acc, r) => ({
      open: acc.open + r.totals.open,
      closed: acc.closed + r.totals.closed,
      total: acc.total + r.totals.total,
      in_progress: acc.in_progress + r.by_category.in_progress,
    }),
    { open: 0, closed: 0, total: 0, in_progress: 0 }
  );
});

// Stale count — pulled from the stale rollup widget's underlying query so
// we don't double-fetch.
const staleQ = useStaleRollup();
const staleTotal = computed(() =>
  (staleQ.data.value?.items ?? []).reduce((a, r) => a + r.stale_count, 0)
);

// Throughput for the KPI sparkline + "closed this week" + delta. We pull
// 24 weeks so we have a full prior-period window for the delta.
const throughputParams = computed(() => {
  const since = new Date();
  since.setUTCDate(since.getUTCDate() - 24 * 7);
  return { since: since.toISOString(), bucket: "week" as const };
});
const throughput24w = useThroughput(throughputParams);

const closedThisWeek = computed(() => {
  const points = throughput24w.data.value?.points ?? [];
  return points.length > 0 ? points[points.length - 1]!.count : 0;
});
const closedPriorWeek = computed(() => {
  const points = throughput24w.data.value?.points ?? [];
  return points.length > 1 ? points[points.length - 2]!.count : 0;
});
const closedSpark = computed(() =>
  (throughput24w.data.value?.points ?? []).slice(-12).map((p) => p.count)
);

// Median cycle time + prior-period delta. Two queries: current 12 weeks,
// prior 12 weeks.
const cycleNowParams = computed(() => {
  const until = new Date();
  const since = new Date(until.getTime() - 12 * 7 * 24 * 60 * 60 * 1000);
  return { since: since.toISOString(), until: until.toISOString() };
});
const cyclePriorParams = computed(() => {
  const until = new Date(Date.now() - 12 * 7 * 24 * 60 * 60 * 1000);
  const since = new Date(until.getTime() - 12 * 7 * 24 * 60 * 60 * 1000);
  return { since: since.toISOString(), until: until.toISOString() };
});

const cycleNow = useQuery({
  queryKey: computed(() => queryKeys.statsCycleTime({ ...cycleNowParams.value, scope: "now" })),
  staleTime: 60 * 1000,
  queryFn: async () => {
    const { data, error } = await api.GET("/v1/stats/cycle-time", {
      params: { query: cycleNowParams.value as never },
    });
    if (error) throw error;
    return data;
  },
});
const cyclePrior = useQuery({
  queryKey: computed(() => queryKeys.statsCycleTime({ ...cyclePriorParams.value, scope: "prior" })),
  staleTime: 60 * 1000,
  queryFn: async () => {
    const { data, error } = await api.GET("/v1/stats/cycle-time", {
      params: { query: cyclePriorParams.value as never },
    });
    if (error) throw error;
    return data;
  },
});

const cycleDelta = computed(() => {
  const now = cycleNow.data.value?.median_ms ?? 0;
  const prev = cyclePrior.data.value?.median_ms ?? 0;
  return formatDeltaPercent(now, prev);
});

</script>

<template>
  <div class="px-6 py-6 max-w-7xl mx-auto space-y-4">
    <header class="flex items-end justify-between">
      <div>
        <h1 class="text-2xl font-semibold tracking-tight">
          Welcome{{ auth.me?.name ? `, ${auth.me.name}` : "" }}
        </h1>
        <p class="mt-1 text-sm text-muted-foreground">
          What's happening across switchyard at a glance.
        </p>
      </div>
    </header>

    <!-- Row 1: KPI strip ──────────────────────────────────────────────────── -->
    <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
      <KpiCard
        label="Open tickets"
        :value="totals.open"
        :loading="projectsStats.isLoading.value"
        :subline="totals.total ? `${totals.closed} closed of ${totals.total}` : undefined"
      />
      <KpiCard
        label="In progress"
        :value="totals.in_progress"
        :loading="projectsStats.isLoading.value"
        :warning="staleTotal > 0 ? `${staleTotal} stale` : null"
      />
      <KpiCard
        label="Closed this week"
        :value="closedThisWeek"
        :loading="throughput24w.isLoading.value"
        :spark="closedSpark"
        :delta-percent="formatDeltaPercent(closedThisWeek, closedPriorWeek)"
        delta-good-when="up"
      />
      <KpiCard
        label="Median cycle time"
        :value="formatDurationMs(cycleNow.data.value?.median_ms ?? 0)"
        :loading="cycleNow.isLoading.value"
        :delta-percent="cycleDelta"
        delta-good-when="down"
        :subline="cycleNow.data.value?.count ? `${cycleNow.data.value.count} closed` : undefined"
      />
    </div>

    <!-- Row 2: How are we doing ──────────────────────────────────────────── -->
    <div class="grid grid-cols-1 lg:grid-cols-12 gap-4">
      <DashboardWidget title="Throughput" class="lg:col-span-6">
        <template #title-prefix>
          <BarChart2 class="h-3.5 w-3.5 text-muted-foreground" />
        </template>
        <template #title-suffix>
          <span class="ml-1 text-[10px] text-muted-foreground">closed/week, last 12</span>
        </template>
        <ThroughputChart :weeks="12" />
      </DashboardWidget>

      <DashboardWidget title="Status distribution" class="lg:col-span-6">
        <template #title-prefix>
          <PieChart class="h-3.5 w-3.5 text-muted-foreground" />
        </template>
        <StatusDonut />
      </DashboardWidget>
    </div>

    <!-- Row 3: Plans awaiting your review (full width review queue) ────────── -->
    <DashboardWidget title="Plans awaiting your review" :padded="false">
      <template #title-prefix>
        <ClipboardCheck class="h-3.5 w-3.5 text-muted-foreground" />
      </template>
      <PlansAwaitingReview :limit="8" />
    </DashboardWidget>

    <!-- Row 4: Recent activity (full width) ──────────────────────────────── -->
    <DashboardWidget title="Recent activity" :padded="false">
      <template #title-prefix>
        <Activity class="h-3.5 w-3.5 text-muted-foreground" />
      </template>
      <ActivityFeed :limit="20" />
    </DashboardWidget>

    <!-- Row 4 (conditional): stale work, only when there's something to see.
         Full-width row at the bottom rather than a tall column upstairs.
         The widget itself still reads from useStaleRollup so the data is
         already in cache; we just gate the wrapper. -->
    <DashboardWidget
      v-if="staleTotal > 0"
      title="Stale work"
      :padded="false"
    >
      <template #title-prefix>
        <Clock class="h-3.5 w-3.5 text-muted-foreground" />
      </template>
      <template #title-suffix>
        <span class="ml-1 text-[10px] font-medium tabular-nums text-rose-600 dark:text-rose-500">
          {{ staleTotal }}
        </span>
      </template>
      <StaleRollupWidget />
    </DashboardWidget>
  </div>
</template>
