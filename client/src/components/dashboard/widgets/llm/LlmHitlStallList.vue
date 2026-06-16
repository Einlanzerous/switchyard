<script setup lang="ts">
// HITL stall list — tickets in_progress with no recent LLM activity. The
// threshold is a global setting (Admin → Observability), shown as context.

import { computed } from "vue";
import { RouterLink } from "vue-router";
import { useLlmHitlStalls } from "@/composables/useLlmInsights";
import { formatHours } from "@/lib/formatLlm";

const props = defineProps<{ project?: string }>();
const params = computed(() => ({ project: props.project }));
const q = useLlmHitlStalls(params);
const items = computed(() => q.data.value?.items ?? []);
</script>

<template>
  <div v-if="q.isLoading.value" class="space-y-2">
    <div v-for="i in 3" :key="i" class="h-8 rounded bg-muted/40 animate-pulse" />
  </div>
  <div v-else-if="items.length === 0" class="py-6 text-center text-xs text-muted-foreground italic">
    No stalls — agents are flowing.
  </div>
  <ul v-else class="divide-y">
    <li v-for="row in items" :key="row.ticket.id" class="px-2 py-2 flex items-center justify-between gap-3">
      <RouterLink
        :to="{ path: '/tickets', query: { focus: row.ticket.key } }"
        class="inline-flex items-center gap-2 min-w-0 hover:underline"
      >
        <span class="font-mono text-xs text-muted-foreground">{{ row.ticket.key }}</span>
        <span class="truncate text-sm">{{ row.ticket.title }}</span>
      </RouterLink>
      <div class="shrink-0 text-right">
        <div class="text-xs font-medium text-amber-600 dark:text-amber-500">
          {{ formatHours(row.hours_in_progress) }} in progress
        </div>
        <div class="text-[11px] text-muted-foreground">
          {{ row.hours_since_activity == null
            ? "no LLM activity"
            : `quiet ${formatHours(row.hours_since_activity)}` }}
        </div>
      </div>
    </li>
  </ul>
</template>
