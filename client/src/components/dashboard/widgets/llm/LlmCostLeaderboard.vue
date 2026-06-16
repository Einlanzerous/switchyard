<script setup lang="ts">
// Most-expensive tickets — or projects — by LLM cost over the window. Rows link
// to the ticket (ticket mode) or the project board (project mode); the no-
// ticket/no-project "Ambient" bucket has no link.

import { computed } from "vue";
import { RouterLink } from "vue-router";
import { useLlmCostLeaderboard } from "@/composables/useLlmInsights";
import { formatUsd, formatCompact, formatLatencyMs } from "@/lib/formatLlm";

const props = defineProps<{
  project?: string;
  since?: string;
  until?: string;
  groupBy?: "ticket" | "project";
}>();
const params = computed(() => ({
  project: props.project,
  since: props.since,
  until: props.until,
  group_by: props.groupBy ?? "ticket",
}));
const q = useLlmCostLeaderboard(params);
const items = computed(() => q.data.value?.items ?? []);
const unit = computed(() => (props.groupBy === "project" ? "project" : "ticket"));
</script>

<template>
  <div v-if="q.isLoading.value" class="space-y-2">
    <div v-for="i in 5" :key="i" class="h-6 rounded bg-muted/40 animate-pulse" />
  </div>
  <div v-else-if="items.length === 0" class="py-6 text-center text-xs text-muted-foreground italic">
    No spend recorded in this window.
  </div>
  <table v-else class="w-full text-sm table-fixed [&_th]:px-2 [&_td]:px-2">
    <thead>
      <tr class="text-[11px] uppercase tracking-wider text-muted-foreground">
        <th class="text-left font-medium pb-2 capitalize">{{ unit }}</th>
        <th class="text-right font-medium pb-2 w-20">Cost</th>
        <th class="text-right font-medium pb-2 w-14 hidden sm:table-cell">Calls</th>
        <th class="text-right font-medium pb-2 w-24 hidden sm:table-cell">Latency</th>
      </tr>
    </thead>
    <tbody>
      <tr v-for="(row, i) in items" :key="row.ticket?.id ?? row.project?.id ?? `ambient-${i}`" class="border-t">
        <td class="py-1.5 overflow-hidden">
          <RouterLink
            v-if="row.ticket"
            :to="{ path: '/tickets', query: { focus: row.ticket.key } }"
            class="flex items-center gap-2 min-w-0 hover:underline"
          >
            <span class="font-mono text-xs text-muted-foreground shrink-0">{{ row.ticket.key }}</span>
            <span class="truncate">{{ row.ticket.title }}</span>
          </RouterLink>
          <RouterLink
            v-else-if="row.project"
            :to="`/projects/${row.project.key}/insights/llm`"
            class="flex items-center gap-2 min-w-0 hover:underline"
          >
            <span class="h-2.5 w-2.5 rounded-sm shrink-0" :style="{ backgroundColor: row.project.color ?? '#888' }" />
            <span class="truncate">{{ row.project.name }}</span>
          </RouterLink>
          <span v-else class="text-muted-foreground italic">Ambient (no {{ unit }})</span>
        </td>
        <td class="py-1.5 text-right tabular-nums font-medium">{{ formatUsd(row.cost_usd) }}</td>
        <td class="py-1.5 text-right tabular-nums text-muted-foreground hidden sm:table-cell">
          {{ formatCompact(row.call_count) }}
        </td>
        <td class="py-1.5 text-right tabular-nums text-muted-foreground hidden sm:table-cell">
          {{ formatLatencyMs(row.avg_latency_ms) }}
        </td>
      </tr>
    </tbody>
  </table>
</template>
