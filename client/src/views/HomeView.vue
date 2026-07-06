<script setup lang="ts">
// Personal at-a-glance landing page — v4 "Elevated" (SWY-140): home is
// reframed around active work, not vanity KPIs.
//
// Layout:
//   header — time-of-day greeting + traffic narrative + "New ticket"
//   row 1  — KPI strip (4): epics in flight / closed 7d / agent share / needs you
//   row 2+ — active-work cards (SWY-141/142/143)
//
// Per-user noise (my open tickets, @mentions) deliberately lives off the
// dashboard: open tickets are one click away via the profile menu's
// "My tickets" link, and @mentions surface in the notification bell.
//
// Each widget owns its own data fetching so a slow query can't blank the
// whole dashboard. Skeleton state is per-widget.

import { computed } from "vue";
import { Activity, Plus } from "lucide-vue-next";
import { useAuthStore } from "@/stores/auth";
import { useUiStore } from "@/stores/ui";
import { useThroughput, useActivityPulse, useEpicsInFlight } from "@/composables/useDashboardData";
import { Button } from "@/components/ui/button";
import UserAvatar from "@/components/UserAvatar.vue";
import KpiCard from "@/components/dashboard/KpiCard.vue";
import DashboardWidget from "@/components/dashboard/DashboardWidget.vue";
import ActivityFeed from "@/components/dashboard/widgets/ActivityFeed.vue";
import ActiveProjectsCard from "@/components/dashboard/widgets/ActiveProjectsCard.vue";
import EpicsInFlightCard from "@/components/dashboard/widgets/EpicsInFlightCard.vue";
import UpNextCard from "@/components/dashboard/widgets/UpNextCard.vue";

const auth = useAuthStore();
const ui = useUiStore();

// ─── Greeting ────────────────────────────────────────────────────────────────

const daypart = computed(() => {
  const h = new Date().getHours();
  if (h < 12) return "morning";
  if (h < 18) return "afternoon";
  return "evening";
});
const firstName = computed(() => auth.me?.name?.trim().split(/\s+/)[0] ?? null);

// ─── KPI feeds ───────────────────────────────────────────────────────────────

// Activity pulse feeds both the narrative ("N projects carrying the
// traffic") and, in SWY-141, the Active-projects card — same cache entry.
const pulseQ = useActivityPulse();
const activeProjectCount = computed(
  () => (pulseQ.data.value?.items ?? []).filter((r) => r.activity_series.some((n) => n > 0)).length
);

// 7-day daily throughput: "Closed · 7d" count + sparkline, the agent share
// split, and the narrative's "agents cleared N" figure.
const throughput7dParams = computed(() => {
  const since = new Date();
  since.setUTCDate(since.getUTCDate() - 7);
  return { since: since.toISOString(), bucket: "day" as const };
});
const throughput7d = useThroughput(throughput7dParams);

const closed7d = computed(() => throughput7d.data.value?.total ?? 0);
const closed7dByAgents = computed(() => throughput7d.data.value?.agent_total ?? 0);
const closedSpark = computed(() =>
  (throughput7d.data.value?.points ?? []).map((p) => p.count)
);

const agentSharePct = computed(() => {
  const t = throughput7d.data.value;
  if (!t || t.total === 0) return null;
  return Math.round((t.agent_total / t.total) * 100);
});

const epicsQ = useEpicsInFlight();
const epicsInFlight = computed(() => epicsQ.data.value?.items ?? []);
const epicsProjectCount = computed(
  () => new Set(epicsInFlight.value.map((e) => e.project.key)).size
);

// "Needs you" — interim source until the SWY-139 review-queue endpoint
// lands: epics flagged stalled ("no LLM activity Nd") by /v1/stats/epics.
// Click-through goes to open epics for the same reason; swap both to the
// review queue with SWY-139.
const needsYou = computed(() => epicsInFlight.value.filter((e) => e.stalled).length);

const narrativeReady = computed(
  () => !pulseQ.isLoading.value && !throughput7d.isLoading.value
);
</script>

<template>
  <div class="px-6 py-6 max-w-7xl mx-auto space-y-4">
    <header class="flex items-end justify-between gap-4">
      <div>
        <h1 class="text-[23px] font-bold tracking-tight leading-tight">
          Good {{ daypart }}{{ firstName ? `, ${firstName}` : "" }}
        </h1>
        <p class="mt-1 text-[13.5px] text-ink-2">
          <template v-if="narrativeReady && closed7d > 0">
            <span class="font-semibold text-ink">{{ activeProjectCount }}</span>
            {{ activeProjectCount === 1 ? "project" : "projects" }} carrying the traffic ·
            agents cleared
            <span class="font-semibold text-ink">{{ closed7dByAgents }}</span>
            {{ closed7dByAgents === 1 ? "ticket" : "tickets" }} for you this week.
          </template>
          <template v-else-if="narrativeReady">
            Quiet week so far — nothing closed in the last 7 days.
          </template>
          <template v-else>
            What's happening across switchyard at a glance.
          </template>
        </p>
      </div>
      <Button class="shrink-0" @click="ui.openCreateTicket(null)">
        <Plus class="h-4 w-4 mr-1.5" />
        New ticket
      </Button>
    </header>

    <!-- Row 1: KPI strip ──────────────────────────────────────────────────── -->
    <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
      <KpiCard
        label="Epics in flight"
        :value="epicsInFlight.length"
        :loading="epicsQ.isLoading.value"
        :subline="epicsProjectCount > 0 ? `across ${epicsProjectCount} active ${epicsProjectCount === 1 ? 'project' : 'projects'}` : undefined"
      />
      <KpiCard
        label="Closed · 7d"
        :value="closed7d"
        :loading="throughput7d.isLoading.value"
        :spark="closedSpark"
      >
        <template #subline>
          <div class="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <UserAvatar :user="{ name: 'agents', type: 'agent' }" size="xs" class="h-3.5 w-3.5 text-[7px]" />
            <span><span class="font-semibold text-ink tabular-nums">{{ closed7dByAgents }}</span> by agents</span>
          </div>
        </template>
      </KpiCard>
      <KpiCard
        label="Agent share"
        :value="agentSharePct != null ? `${agentSharePct}%` : '—'"
        :loading="throughput7d.isLoading.value"
        :split-bar="agentSharePct != null
          ? { leftPct: agentSharePct, leftLabel: 'agents', rightLabel: `you ${100 - agentSharePct}%` }
          : null"
        :subline="agentSharePct == null ? 'no closures this week' : undefined"
      />
      <KpiCard
        label="Needs you"
        variant="accent"
        :value="needsYou"
        :loading="epicsQ.isLoading.value"
        subline="agents stalled, waiting on review"
        :to="{ path: '/tickets', query: { type: 'epic', status: 'in_progress' } }"
      />
    </div>

    <!-- Row 2: active projects (1.9fr) + epics in flight (1fr). No items-start:
         the cards stretch to the row height so the pair reads as one band.
         min-w-0 keeps a wide row's min-content from forcing the column past
         its fr share (the "card sticks out on resize" failure mode). ──────── -->
    <div class="grid grid-cols-1 lg:grid-cols-[1.9fr_1fr] gap-4">
      <ActiveProjectsCard class="min-w-0" />
      <EpicsInFlightCard class="min-w-0" />
    </div>

    <!-- Row 3: recent activity (1.9fr) + up next (1fr) ──────────────────────── -->
    <div class="grid grid-cols-1 lg:grid-cols-[1.9fr_1fr] gap-4">
      <DashboardWidget title="Recent activity" :padded="false" class="min-w-0">
        <template #title-prefix>
          <Activity class="h-3.5 w-3.5 text-muted-foreground" />
        </template>
        <template #actions>
          <!-- Legend, not a filter: the feed is agent-dominated by design. -->
          <span class="flex items-center gap-1.5 rounded bg-surface-4 px-1.5 py-0.5 font-mono text-[10px] text-ink-3">
            <UserAvatar :user="{ name: 'agents', type: 'agent' }" size="xs" class="h-3.5 w-3.5 text-[7px]" />
            agents
          </span>
        </template>
        <ActivityFeed :limit="7" />
      </DashboardWidget>

      <UpNextCard class="min-w-0" />
    </div>
  </div>
</template>
