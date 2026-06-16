<script setup lang="ts">
// LLM KPI strip — cost (with WoW delta + call count), p95 latency, error rate
// (with "elevated" flag), cache hit. Scoped by `project`; windowed by the
// shared range so every tile counts the same calls.

import { computed } from "vue";
import { useLlmKpi } from "@/composables/useLlmInsights";
import KpiCard from "@/components/dashboard/KpiCard.vue";
import { formatUsd, formatLatencyMs, formatPct, formatCompact } from "@/lib/formatLlm";

const props = defineProps<{
  project?: string;
  since?: string;
  until?: string;
}>();
const params = computed(() => ({ project: props.project, since: props.since, until: props.until }));
const q = useLlmKpi(params);
const d = computed(() => q.data.value);
</script>

<template>
  <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
    <KpiCard
      label="Cost"
      :value="formatUsd(d?.cost_usd ?? 0)"
      :note="`${formatCompact(d?.call_count ?? 0)} calls`"
      :loading="q.isLoading.value"
      :delta-percent="d?.cost_delta_pct ?? null"
      delta-good-when="down"
    />
    <KpiCard
      label="p95 latency"
      :value="formatLatencyMs(d?.p95_latency_ms ?? 0)"
      :loading="q.isLoading.value"
    />
    <KpiCard
      label="Error rate"
      :value="formatPct(d?.error_rate_pct ?? 0)"
      :note="(d?.error_rate_pct ?? 0) > 5 ? 'elevated' : null"
      note-tone="warn"
      :loading="q.isLoading.value"
    />
    <KpiCard
      label="Cache hit rate"
      :value="formatPct(d?.cache_hit_rate_pct)"
      :loading="q.isLoading.value"
    />
  </div>
</template>
