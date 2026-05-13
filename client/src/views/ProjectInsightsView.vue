<script setup lang="ts">
// Per-project Insights view (`/projects/:key/insights`). Tab sibling of
// ProjectBoardView. KPI strip + four widgets: throughput, status donut,
// cycle time per type, assignee leaderboard. Each widget is independent
// — its skeleton/error stays scoped.

import { computed } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ArrowLeft, Plus, BarChart2, PieChart, Clock, Users as UsersIcon } from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { useUiStore } from "@/stores/ui";
import { useProjectStats } from "@/composables/useProjectStats";
import { useThroughput } from "@/composables/useDashboardData";
import { formatDurationMs, formatDeltaPercent } from "@/lib/formatDuration";
import KpiCard from "@/components/dashboard/KpiCard.vue";
import DashboardWidget from "@/components/dashboard/DashboardWidget.vue";
import InsightsTabs from "@/components/dashboard/InsightsTabs.vue";
import ThroughputChart from "@/components/dashboard/widgets/ThroughputChart.vue";
import StatusDonut from "@/components/dashboard/widgets/StatusDonut.vue";
import CycleTimeWidget from "@/components/dashboard/widgets/CycleTimeWidget.vue";
import AssigneeLeaderboard from "@/components/dashboard/widgets/AssigneeLeaderboard.vue";

const route = useRoute();
const router = useRouter();
const ui = useUiStore();

const projectKey = computed(() => {
  const v = route.params.key;
  return typeof v === "string" ? v : "";
});

const projectKeyOrNull = computed(() => projectKey.value || null);
const stats = useProjectStats(projectKeyOrNull);

// Closed-this-week mini-stat needs a 24-week throughput query so we have a
// prior-period to delta against.
const throughputParams = computed(() => {
  const since = new Date();
  since.setUTCDate(since.getUTCDate() - 24 * 7);
  return { project: projectKey.value, since: since.toISOString(), bucket: "week" as const };
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

function back() { router.push("/projects"); }
</script>

<template>
  <div class="flex flex-col h-full">
    <!-- Header — same shell as ProjectBoardView so the tab swap leaves the
         surrounding chrome untouched. Back returns to /projects. -->
    <div class="border-b bg-background/95 backdrop-blur sticky top-0 z-10">
      <div class="px-4 h-12 flex items-center gap-2">
        <Button variant="ghost" size="sm" class="h-8 -ml-2" @click="back">
          <ArrowLeft class="h-3.5 w-3.5 mr-1" /> Back
        </Button>
        <Separator orientation="vertical" class="h-5" />
        <span class="font-mono text-sm text-muted-foreground">{{ projectKey }}</span>
        <span v-if="stats.data.value?.project.name" class="text-muted-foreground/40">—</span>
        <span v-if="stats.data.value?.project.name" class="text-sm font-medium truncate">
          {{ stats.data.value.project.name }}
        </span>
        <Separator orientation="vertical" class="h-5" />
        <InsightsTabs
          :board-path="`/projects/${projectKey}/board`"
          :insights-path="`/projects/${projectKey}/insights`"
        />
        <div class="flex-1 min-w-0" />
        <Button size="sm" class="h-8" @click="ui.openCreateTicket(projectKey)">
          <Plus class="h-3.5 w-3.5 mr-1.5" /> New ticket
        </Button>
      </div>
    </div>

    <!-- Body -->
    <div class="flex-1 overflow-auto px-4 py-4 space-y-4">
      <!-- KPI strip — scoped to project. -->
      <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-3">
        <KpiCard
          label="Open"
          :value="stats.data.value?.totals.open ?? 0"
          :loading="stats.isLoading.value"
          :subline="stats.data.value
            ? `${stats.data.value.totals.closed} of ${stats.data.value.totals.total} closed`
            : undefined"
        />
        <KpiCard
          label="In progress"
          :value="stats.data.value?.by_category.in_progress ?? 0"
          :loading="stats.isLoading.value"
          :warning="(stats.data.value?.stale_in_progress ?? 0) > 0
            ? `${stats.data.value!.stale_in_progress} stale`
            : null"
        />
        <KpiCard
          label="Overdue"
          :value="stats.data.value?.overdue ?? 0"
          :loading="stats.isLoading.value"
          :warning="(stats.data.value?.overdue ?? 0) > 0 ? 'past due, still open' : null"
        />
        <KpiCard
          label="Completed late"
          :value="stats.data.value?.completed_late ?? 0"
          :loading="stats.isLoading.value"
          :subline="(stats.data.value?.completed_late ?? 0) > 0 ? 'shipped past due date' : 'all on time'"
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
          label="Closed (12w)"
          :value="(throughput24w.data.value?.points ?? []).slice(-12).reduce((a, b) => a + b.count, 0)"
          :loading="throughput24w.isLoading.value"
          :subline="stats.data.value?.most_recent_activity
            ? `Last update ${new Date(stats.data.value.most_recent_activity).toLocaleDateString()}`
            : undefined"
        />
      </div>

      <!-- Charts row -->
      <div class="grid grid-cols-1 lg:grid-cols-12 gap-4">
        <DashboardWidget title="Throughput" class="lg:col-span-7">
          <template #title-prefix>
            <BarChart2 class="h-3.5 w-3.5 text-muted-foreground" />
          </template>
          <template #title-suffix>
            <span class="ml-1 text-[10px] text-muted-foreground">closed/week, last 12</span>
          </template>
          <ThroughputChart :project="projectKey" :weeks="12" />
        </DashboardWidget>
        <DashboardWidget title="Status distribution" class="lg:col-span-5">
          <template #title-prefix>
            <PieChart class="h-3.5 w-3.5 text-muted-foreground" />
          </template>
          <StatusDonut :project-key="projectKey" />
        </DashboardWidget>
      </div>

      <div class="grid grid-cols-1 lg:grid-cols-12 gap-4">
        <DashboardWidget title="Cycle time" class="lg:col-span-7">
          <template #title-prefix>
            <Clock class="h-3.5 w-3.5 text-muted-foreground" />
          </template>
          <template #title-suffix>
            <span class="ml-1 text-[10px] text-muted-foreground">in_progress only</span>
          </template>
          <CycleTimeWidget :project="projectKey" />
        </DashboardWidget>
        <DashboardWidget title="Assignees" class="lg:col-span-5">
          <template #title-prefix>
            <UsersIcon class="h-3.5 w-3.5 text-muted-foreground" />
          </template>
          <AssigneeLeaderboard :project-key="projectKey" />
        </DashboardWidget>
      </div>
    </div>
  </div>
</template>
