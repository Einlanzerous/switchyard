<script setup lang="ts">
// "Up next" dashboard card (SWY-143): the newest unstarted (backlog) tickets
// — what an agent or human would naturally pick up next. Plain /v1/tickets
// query, no bespoke stats endpoint.

import { computed } from "vue";
import { useRouter } from "vue-router";
import { useQuery } from "@tanstack/vue-query";
import { ArrowRight } from "lucide-vue-next";
import { api } from "@/lib/api";
import { queryKeys } from "@/lib/queryKeys";
import DashboardWidget from "@/components/dashboard/DashboardWidget.vue";
import StatusBadge from "@/components/tickets/StatusBadge.vue";

const LIMIT = 5;

const router = useRouter();

const params = {
  status: "backlog",
  sort_by: "created_at" as const,
  sort_order: "desc" as const,
  limit: LIMIT,
};

const q = useQuery({
  queryKey: queryKeys.tickets({ ...params, scope: "up-next" } as never),
  staleTime: 30 * 1000,
  queryFn: async () => {
    const { data, error } = await api.GET("/v1/tickets", {
      params: { query: params as never },
    });
    if (error) throw error;
    return data;
  },
});

const items = computed(() => (q.data.value?.items ?? []).slice(0, LIMIT));

function open(key: string) {
  router.push(`/tickets/${key}`);
}
</script>

<template>
  <DashboardWidget title="Up next" :loading="q.isLoading.value" :error="q.error.value" :padded="false">
    <template #title-prefix>
      <ArrowRight class="h-3.5 w-3.5 text-muted-foreground" />
    </template>
    <template #title-suffix>
      <span class="ml-1 font-mono text-[10px] text-ink-3">newest · unstarted</span>
    </template>

    <div v-if="items.length === 0" class="py-8 text-center text-xs text-muted-foreground">
      Backlog is clear.
    </div>

    <ul v-else class="divide-y divide-border/60">
      <li
        v-for="t in items"
        :key="t.id"
        class="flex items-center gap-3 px-4 py-2.5 cursor-pointer hover:bg-accent/40 transition-colors"
        @click="open(t.key)"
      >
        <span class="shrink-0 font-mono text-[11px] text-ink-3">{{ t.key }}</span>
        <span class="flex-1 min-w-0 truncate text-[13px]">{{ t.title }}</span>
        <span
          v-if="t.labels[0]"
          class="flex shrink-0 items-center gap-1.5 rounded bg-surface-4 px-1.5 py-px font-mono text-[10px] text-ink-2"
        >
          <span
            class="h-[5px] w-[5px] rounded-full"
            :style="{ backgroundColor: t.labels[0].color ?? undefined }"
          />
          {{ t.labels[0].name }}
        </span>
        <StatusBadge
          v-else
          :category="t.status.category"
          :display-name="t.status.display_name"
          size="sm"
        />
      </li>
    </ul>
  </DashboardWidget>
</template>
