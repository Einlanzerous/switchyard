<script setup lang="ts">
// Stale-work widget for the home dashboard. Rolls up at project level when
// 2+ stale tickets share a project; shows the single ticket directly when
// only 1. Click → routes to project board (filtered) or opens drawer.

import { useRoute, useRouter } from "vue-router";
import { Loader2, FolderKanban } from "lucide-vue-next";
import { useStaleRollup } from "@/composables/useDashboardData";
import TypeIcon from "@/components/tickets/TypeIcon.vue";

const route = useRoute();
const router = useRouter();
const q = useStaleRollup();

function clickProject(projectKey: string) {
  router.push(`/projects/${projectKey}/board`);
}

function clickTicket(key: string) {
  router.replace({ query: { ...route.query, focus: key } });
}
</script>

<template>
  <div v-if="q.isLoading.value" class="flex items-center justify-center py-6 text-xs text-muted-foreground">
    <Loader2 class="h-3.5 w-3.5 animate-spin mr-1.5" /> Loading
  </div>
  <div
    v-else-if="(q.data.value?.items ?? []).length === 0"
    class="flex flex-col items-center justify-center py-6 text-xs text-muted-foreground"
  >
    <span class="text-2xl mb-1">✓</span>
    Nothing stale.
  </div>
  <ul v-else class="divide-y divide-border/60 overflow-hidden rounded-b-xl">
    <li
      v-for="row in q.data.value?.items"
      :key="row.project.id"
      class="px-4 py-2 hover:bg-accent/40 cursor-pointer transition-colors"
      @click="row.sample_ticket
        ? clickTicket(row.sample_ticket.key)
        : clickProject(row.project.key)"
    >
      <!-- Single-ticket case: show the actual ticket row. -->
      <div v-if="row.sample_ticket" class="flex items-center gap-2 min-w-0">
        <TypeIcon :type="row.sample_ticket.type" class="h-3.5 w-3.5 shrink-0" />
        <span class="font-mono text-[11px] text-muted-foreground">{{ row.sample_ticket.key }}</span>
        <span class="text-sm truncate">{{ row.sample_ticket.title }}</span>
      </div>
      <!-- Multi-ticket case: project rollup. -->
      <div v-else class="flex items-center gap-2 min-w-0">
        <FolderKanban class="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        <span class="font-mono text-[11px] text-muted-foreground">{{ row.project.key }}</span>
        <span class="text-sm font-medium truncate">{{ row.project.name }}</span>
        <span class="ml-auto text-[11px] tabular-nums text-rose-600 dark:text-rose-500 font-medium shrink-0">
          {{ row.stale_count }} stale
        </span>
      </div>
    </li>
  </ul>
</template>
