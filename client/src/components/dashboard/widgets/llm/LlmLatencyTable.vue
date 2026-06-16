<script setup lang="ts">
// Latency p50/p95/p99 per (model, operation), call-weighted over the window.

import { computed } from "vue";
import { useLlmLatency } from "@/composables/useLlmInsights";
import { formatLatencyMs, formatCompact } from "@/lib/formatLlm";

const props = defineProps<{ project?: string; since?: string; until?: string }>();
const params = computed(() => ({ project: props.project, since: props.since, until: props.until }));
const q = useLlmLatency(params);
const rows = computed(() => q.data.value?.rows ?? []);
</script>

<template>
  <div v-if="q.isLoading.value" class="space-y-2">
    <div v-for="i in 5" :key="i" class="h-6 rounded bg-muted/40 animate-pulse" />
  </div>
  <div v-else-if="rows.length === 0" class="py-6 text-center text-xs text-muted-foreground italic">
    No latency data in this window.
  </div>
  <table v-else class="w-full text-sm table-fixed [&_th]:px-2 [&_td]:px-2">
    <thead>
      <tr class="text-[11px] uppercase tracking-wider text-muted-foreground">
        <th class="text-left font-medium pb-2">Model · Operation</th>
        <th class="text-right font-medium pb-2 w-16">p50</th>
        <th class="text-right font-medium pb-2 w-16">p95</th>
        <th class="text-right font-medium pb-2 w-16 hidden sm:table-cell">p99</th>
        <th class="text-right font-medium pb-2 w-14 hidden sm:table-cell">Calls</th>
      </tr>
    </thead>
    <tbody>
      <tr v-for="row in rows" :key="`${row.model}|${row.operation}`" class="border-t">
        <td class="py-1.5 overflow-hidden">
          <div class="truncate">
            <span class="font-mono text-xs">{{ row.model }}</span>
            <span class="text-muted-foreground"> · {{ row.operation }}</span>
          </div>
        </td>
        <td class="py-1.5 text-right tabular-nums">{{ formatLatencyMs(row.p50_ms) }}</td>
        <td class="py-1.5 text-right tabular-nums font-medium">{{ formatLatencyMs(row.p95_ms) }}</td>
        <td class="py-1.5 text-right tabular-nums text-muted-foreground hidden sm:table-cell">
          {{ formatLatencyMs(row.p99_ms) }}
        </td>
        <td class="py-1.5 text-right tabular-nums text-muted-foreground hidden sm:table-cell">
          {{ formatCompact(row.call_count) }}
        </td>
      </tr>
    </tbody>
  </table>
</template>
