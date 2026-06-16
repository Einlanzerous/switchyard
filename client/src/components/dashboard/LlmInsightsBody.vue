<script setup lang="ts">
// Shared body for the LLM Insights surfaces. The window (since/until/bucket)
// comes from the selector in the view header; `project` scopes every tile. Same
// widgets + layout as the project Insights pages so the two stay in lockstep.

import { ref } from "vue";
import { BarChart2, Coins, Clock, AlertTriangle, PauseCircle } from "lucide-vue-next";
import { cn } from "@/lib/utils";
import type { LlmCostGroupBy } from "@switchyard/shared";
import DashboardWidget from "@/components/dashboard/DashboardWidget.vue";
import LlmKpiStrip from "@/components/dashboard/widgets/llm/LlmKpiStrip.vue";
import LlmTokenSpendChart from "@/components/dashboard/widgets/llm/LlmTokenSpendChart.vue";
import LlmCostLeaderboard from "@/components/dashboard/widgets/llm/LlmCostLeaderboard.vue";
import LlmLatencyTable from "@/components/dashboard/widgets/llm/LlmLatencyTable.vue";
import LlmErrorRateChart from "@/components/dashboard/widgets/llm/LlmErrorRateChart.vue";
import LlmHitlStallList from "@/components/dashboard/widgets/llm/LlmHitlStallList.vue";

defineProps<{
  project?: string;
  since?: string;
  until?: string;
  bucket?: "day" | "week";
}>();

const costGroupBy = ref<LlmCostGroupBy>("ticket");
const segBtn = (active: boolean) =>
  cn("px-2.5 py-1 rounded transition-colors", active ? "bg-accent text-foreground font-medium" : "text-muted-foreground hover:text-foreground");
</script>

<template>
  <div class="flex-1 overflow-auto px-4 py-4 space-y-4">
    <LlmKpiStrip :project="project" :since="since" :until="until" />

    <div class="grid grid-cols-1 lg:grid-cols-12 gap-4">
      <DashboardWidget title="Spend Over Time" class="lg:col-span-7">
        <template #title-prefix><BarChart2 class="h-3.5 w-3.5 text-muted-foreground" /></template>
        <template #title-suffix>
          <span class="ml-1 text-[10px] text-muted-foreground">$ by model</span>
        </template>
        <LlmTokenSpendChart :project="project" :since="since" :until="until" :bucket="bucket" />
      </DashboardWidget>
      <DashboardWidget title="Cost By" class="lg:col-span-5">
        <template #title-prefix><Coins class="h-3.5 w-3.5 text-muted-foreground" /></template>
        <template #actions>
          <div class="inline-flex rounded-md border p-0.5 text-[11px]">
            <button type="button" :class="segBtn(costGroupBy === 'ticket')" @click="costGroupBy = 'ticket'">Ticket</button>
            <button type="button" :class="segBtn(costGroupBy === 'project')" @click="costGroupBy = 'project'">Project</button>
          </div>
        </template>
        <LlmCostLeaderboard :project="project" :since="since" :until="until" :group-by="costGroupBy" />
      </DashboardWidget>
    </div>

    <div class="grid grid-cols-1 lg:grid-cols-12 gap-4">
      <DashboardWidget title="Latency" class="lg:col-span-7">
        <template #title-prefix><Clock class="h-3.5 w-3.5 text-muted-foreground" /></template>
        <template #title-suffix>
          <span class="ml-1 text-[10px] text-muted-foreground">call-weighted</span>
        </template>
        <LlmLatencyTable :project="project" :since="since" :until="until" />
      </DashboardWidget>
      <DashboardWidget title="Errors" class="lg:col-span-5">
        <template #title-prefix><AlertTriangle class="h-3.5 w-3.5 text-muted-foreground" /></template>
        <template #title-suffix>
          <span class="ml-1 text-[10px] text-muted-foreground">% of calls, by code</span>
        </template>
        <LlmErrorRateChart :project="project" :since="since" :until="until" :bucket="bucket" />
      </DashboardWidget>
    </div>

    <DashboardWidget title="HITL Stalls">
      <template #title-prefix><PauseCircle class="h-3.5 w-3.5 text-muted-foreground" /></template>
      <template #title-suffix>
        <span class="ml-1 text-[10px] text-muted-foreground">in_progress, no recent LLM activity</span>
      </template>
      <LlmHitlStallList :project="project" />
    </DashboardWidget>
  </div>
</template>
