<script setup lang="ts">
// Per-board Insights view (`/boards/:id/insights`). Aggregates across the
// projects on the board. Headlines: cumulative flow (3.0b CFD), throughput,
// status by-project. KPIs: open / in-progress / closed-this-week / cycle.

import { computed } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useQuery } from "@tanstack/vue-query";
import { ArrowLeft, BarChart2, Layers, PieChart, Plus, Clock } from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { useUiStore } from "@/stores/ui";
import { useBoardDetail } from "@/composables/useBoards";
import { useThroughput } from "@/composables/useDashboardData";
import { api } from "@/lib/api";
import { queryKeys } from "@/lib/queryKeys";
import { formatDeltaPercent, formatDurationMs } from "@/lib/formatDuration";
import KpiCard from "@/components/dashboard/KpiCard.vue";
import DashboardWidget from "@/components/dashboard/DashboardWidget.vue";
import InsightsTabs from "@/components/dashboard/InsightsTabs.vue";
import ThroughputChart from "@/components/dashboard/widgets/ThroughputChart.vue";
import CumulativeFlowChart from "@/components/dashboard/widgets/CumulativeFlowChart.vue";
import CycleTimeWidget from "@/components/dashboard/widgets/CycleTimeWidget.vue";
import Chart from "@/components/charts/Chart.vue";

const route = useRoute();
const router = useRouter();
const ui = useUiStore();

const boardId = computed(() => {
  const v = route.params.id;
  return typeof v === "string" ? v : null;
});

const { board } = useBoardDetail(boardId);

// CSV of project keys this board scopes to. Used as the `project` filter
// for every stats endpoint we hit.
const projectCsv = computed(() => {
  const keys = board.value?.projects.map((p) => p.key) ?? [];
  return keys.length > 0 ? keys.join(",") : undefined;
});

// Bulk per-project stats — we sum the relevant fields client-side for the
// KPI strip. Keeps the server-side endpoint cheap and reusable.
const projectsStats = useQuery({
  queryKey: queryKeys.statsProjects(),
  staleTime: 60 * 1000,
  queryFn: async () => {
    const { data, error } = await api.GET("/v1/stats/projects");
    if (error) throw error;
    return data;
  },
});

// Filter the bulk feed to only this board's projects, then sum.
const boardProjectIds = computed(() =>
  new Set(board.value?.projects.map((p) => p.id) ?? [])
);
const totals = computed(() => {
  const items = (projectsStats.data.value?.items ?? []).filter(
    (r) => boardProjectIds.value.has(r.project.id)
  );
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

const throughputParams = computed(() => {
  const since = new Date();
  since.setUTCDate(since.getUTCDate() - 24 * 7);
  return {
    project: projectCsv.value,
    since: since.toISOString(),
    bucket: "week" as const,
  };
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

const cycleParams = computed(() => {
  const since = new Date();
  since.setUTCDate(since.getUTCDate() - 12 * 7);
  return { project: projectCsv.value, since: since.toISOString() };
});
const cycle = useQuery({
  queryKey: computed(() => queryKeys.statsCycleTime(cycleParams.value)),
  staleTime: 60 * 1000,
  queryFn: async () => {
    const { data, error } = await api.GET("/v1/stats/cycle-time", {
      params: { query: cycleParams.value as never },
    });
    if (error) throw error;
    return data;
  },
});

// Status by project — stacked bar.
const statusByProject = computed(() => {
  const items = (projectsStats.data.value?.items ?? []).filter(
    (r) => boardProjectIds.value.has(r.project.id)
  );
  return {
    grid: { left: 56, right: 8, top: 24, bottom: 32 },
    legend: { bottom: 0, type: "scroll", icon: "circle", itemHeight: 8 },
    tooltip: { trigger: "axis" },
    xAxis: { type: "value", minInterval: 1 },
    yAxis: {
      type: "category",
      data: items.map((r) => r.project.key),
      axisTick: { show: false },
      axisLine: { show: false },
    },
    series: [
      { name: "Backlog", type: "bar", stack: "t", data: items.map((r) => r.by_category.backlog) },
      { name: "Planning", type: "bar", stack: "t", data: items.map((r) => r.by_category.planning) },
      { name: "In Progress", type: "bar", stack: "t", data: items.map((r) => r.by_category.in_progress) },
      { name: "Blocked", type: "bar", stack: "t", data: items.map((r) => r.by_category.blocked) },
      { name: "Closed", type: "bar", stack: "t", data: items.map((r) => r.by_category.closed) },
    ].map((s) => ({ ...s, barMaxWidth: 18 })),
  };
});
const statusByProjectEmpty = computed(() => {
  const items = (projectsStats.data.value?.items ?? []).filter(
    (r) => boardProjectIds.value.has(r.project.id)
  );
  return items.length === 0;
});

function back() { router.push("/boards"); }
</script>

<template>
  <div class="flex flex-col h-full">
    <!-- Header — mirrors BoardView so the tab swap leaves chrome untouched. -->
    <div class="border-b bg-background/95 backdrop-blur sticky top-0 z-10">
      <div class="px-4 h-12 flex items-center gap-2">
        <Button variant="ghost" size="sm" class="h-8 -ml-2" @click="back">
          <ArrowLeft class="h-3.5 w-3.5 mr-1" /> Back
        </Button>
        <Separator orientation="vertical" class="h-5" />
        <span class="text-sm font-medium truncate">{{ board?.name ?? "Board" }}</span>
        <span v-if="board" class="text-[11px] text-muted-foreground whitespace-nowrap">
          · {{ board.projects.length }} project{{ board.projects.length === 1 ? "" : "s" }}
        </span>
        <Separator orientation="vertical" class="h-5" />
        <InsightsTabs
          :board-path="`/boards/${boardId}`"
          :insights-path="`/boards/${boardId}/insights`"
        />
        <div class="flex-1 min-w-0" />
        <Button
          size="sm"
          class="h-8"
          :disabled="!board"
          @click="ui.openCreateTicket(board?.projects[0]?.key ?? null)"
        >
          <Plus class="h-3.5 w-3.5 mr-1.5" /> New ticket
        </Button>
      </div>
    </div>

    <div class="flex-1 overflow-auto px-4 py-4 space-y-4">
      <!-- KPI strip -->
      <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <KpiCard
          label="Open"
          :value="totals.open"
          :loading="projectsStats.isLoading.value"
          :subline="totals.total ? `${totals.closed} of ${totals.total} closed` : undefined"
        />
        <KpiCard
          label="In progress"
          :value="totals.in_progress"
          :loading="projectsStats.isLoading.value"
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
          :value="formatDurationMs(cycle.data.value?.median_ms ?? 0)"
          :loading="cycle.isLoading.value"
          :subline="cycle.data.value?.count ? `${cycle.data.value.count} closed` : undefined"
        />
      </div>

      <!-- Cumulative flow — the headline chart for the board view. -->
      <DashboardWidget title="Cumulative flow">
        <template #title-prefix>
          <Layers class="h-3.5 w-3.5 text-muted-foreground" />
        </template>
        <template #title-suffix>
          <span class="ml-1 text-[10px] text-muted-foreground">stacked, last 12 weeks</span>
        </template>
        <CumulativeFlowChart :project="projectCsv" :weeks="12" />
      </DashboardWidget>

      <div class="grid grid-cols-1 lg:grid-cols-12 gap-4">
        <DashboardWidget title="Throughput" class="lg:col-span-7">
          <template #title-prefix>
            <BarChart2 class="h-3.5 w-3.5 text-muted-foreground" />
          </template>
          <template #title-suffix>
            <span class="ml-1 text-[10px] text-muted-foreground">closed/week, last 12</span>
          </template>
          <ThroughputChart :project="projectCsv" :weeks="12" />
        </DashboardWidget>
        <DashboardWidget title="Status by project" class="lg:col-span-5">
          <template #title-prefix>
            <PieChart class="h-3.5 w-3.5 text-muted-foreground" />
          </template>
          <Chart :option="statusByProject" :empty="statusByProjectEmpty" height="220px" />
        </DashboardWidget>
      </div>

      <DashboardWidget title="Cycle time">
        <template #title-prefix>
          <Clock class="h-3.5 w-3.5 text-muted-foreground" />
        </template>
        <template #title-suffix>
          <span class="ml-1 text-[10px] text-muted-foreground">in_progress only</span>
        </template>
        <CycleTimeWidget :project="projectCsv" />
      </DashboardWidget>
    </div>
  </div>
</template>
