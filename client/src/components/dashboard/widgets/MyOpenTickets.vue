<script setup lang="ts">
// "My open tickets" panel — the human-user version. Shows tickets assigned
// to the current user that aren't closed. Compact rows, click → drawer.

import { computed } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useQuery } from "@tanstack/vue-query";
import { Inbox, Loader2 } from "lucide-vue-next";
import { api } from "@/lib/api";
import { queryKeys } from "@/lib/queryKeys";
import { useAuthStore } from "@/stores/auth";
import TypeIcon from "@/components/tickets/TypeIcon.vue";
import PriorityBadge from "@/components/tickets/PriorityBadge.vue";

const auth = useAuthStore();
const route = useRoute();
const router = useRouter();

const filters = computed(() => ({
  assignee: auth.me?.id,
  // Server `status` query takes category names; "not closed" isn't directly
  // expressible, so we pull all and filter client-side. The list is small
  // by definition (only what's assigned to one human).
}));

const enabled = computed(() => !!auth.me?.id);

const q = useQuery({
  queryKey: computed(() => ["sw", "home", "my-open", auth.me?.id]),
  enabled,
  staleTime: 30 * 1000,
  queryFn: async () => {
    const { data, error } = await api.GET("/v1/tickets", {
      params: { query: { assignee: auth.me!.id, limit: 50 } },
    });
    if (error) throw error;
    return data;
  },
});

const open = computed(() =>
  (q.data.value?.items ?? []).filter((t) => t.status.category !== "closed")
);

function click(key: string) {
  router.replace({ query: { ...route.query, focus: key } });
}

function viewAll() {
  router.push(`/tickets?assignee=${auth.me?.id}`);
}

defineExpose({ viewAll });
</script>

<template>
  <div v-if="q.isLoading.value" class="flex items-center justify-center py-6 text-xs text-muted-foreground">
    <Loader2 class="h-3.5 w-3.5 animate-spin mr-1.5" /> Loading
  </div>
  <div
    v-else-if="open.length === 0"
    class="flex flex-col items-center justify-center py-8 text-xs text-muted-foreground"
  >
    <Inbox class="h-6 w-6 mb-1.5 text-muted-foreground/40" />
    Nothing assigned to you.
  </div>
  <ul v-else class="divide-y divide-border/60 overflow-hidden rounded-b-xl">
    <li
      v-for="t in open.slice(0, 8)"
      :key="t.id"
      class="flex items-center gap-2 px-4 py-2 hover:bg-accent/40 cursor-pointer transition-colors"
      @click="click(t.key)"
    >
      <TypeIcon :type="t.type" class="h-3.5 w-3.5 shrink-0" />
      <span class="font-mono text-[11px] text-muted-foreground shrink-0">{{ t.key }}</span>
      <span class="text-sm truncate flex-1 min-w-0">{{ t.title }}</span>
      <span class="hidden sm:inline text-[11px] text-muted-foreground shrink-0">
        {{ t.status.display_name }}
      </span>
      <PriorityBadge v-if="t.priority" :priority="t.priority" class="shrink-0" />
    </li>
  </ul>
</template>
