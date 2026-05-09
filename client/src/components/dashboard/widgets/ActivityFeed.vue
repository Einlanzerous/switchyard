<script setup lang="ts">
// Compact list of recent events. Click row → opens drawer. Used on the
// Home dashboard. Future: per-project Insights might show a scoped feed.

import { computed } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useQuery } from "@tanstack/vue-query";
import { Activity } from "lucide-vue-next";
import UserAvatar from "@/components/UserAvatar.vue";
import { api } from "@/lib/api";
import { queryKeys } from "@/lib/queryKeys";
import { formatRelativeTime } from "@/lib/formatTime";

const props = defineProps<{
  project?: string;     // CSV of project keys
  limit?: number;
}>();

const route = useRoute();
const router = useRouter();

const params = computed(() => ({
  project: props.project,
  limit: props.limit ?? 20,
}));

const q = useQuery({
  queryKey: queryKeys.events(params.value),
  staleTime: 30 * 1000,
  queryFn: async () => {
    const { data, error } = await api.GET("/v1/events", {
      params: { query: params.value as never },
    });
    if (error) throw error;
    return data;
  },
});

const items = computed(() => q.data.value?.items ?? []);

function actionVerb(event: string): string {
  switch (event) {
    case "ticket.created": return "created";
    case "ticket.updated": return "updated";
    case "ticket.status_changed": return "moved";
    case "ticket.assigned": return "assigned";
    case "ticket.closed": return "closed";
    case "ticket.released": return "released";
    case "ticket.deleted": return "deleted";
    case "comment.created": return "commented on";
    case "comment.updated": return "edited a comment on";
    case "comment.deleted": return "removed a comment on";
    case "attachment.added": return "attached a file to";
    case "attachment.removed": return "detached a file from";
    case "project.created": return "created project";
    case "project.updated": return "updated project";
    case "project.deleted": return "deleted project";
    default: return event;
  }
}

function open(item: typeof items.value[number]) {
  if (!item.ticket?.key) return;
  router.replace({ query: { ...route.query, focus: item.ticket.key } });
}
</script>

<template>
  <div v-if="q.isLoading.value" class="space-y-2">
    <div v-for="n in 6" :key="n" class="flex items-center gap-2 px-1">
      <div class="h-6 w-6 rounded-full bg-muted/50" />
      <div class="flex-1 h-4 bg-muted/50 rounded" />
    </div>
  </div>
  <div v-else-if="items.length === 0" class="flex flex-col items-center justify-center py-6 text-xs text-muted-foreground">
    <Activity class="h-5 w-5 mb-1.5 text-muted-foreground/40" />
    No recent activity.
  </div>
  <ul v-else class="divide-y divide-border/60 overflow-hidden rounded-b-xl">
    <li
      v-for="ev in items"
      :key="ev.id"
      class="flex items-center gap-3 px-4 py-2.5 text-sm hover:bg-accent/40 transition-colors"
      :class="ev.ticket ? 'cursor-pointer' : 'cursor-default'"
      @click="open(ev)"
    >
      <UserAvatar :user="ev.actor" class="shrink-0" />
      <span class="text-muted-foreground truncate flex-1 min-w-0">
        <span class="text-foreground font-medium">{{ ev.actor?.name ?? "system" }}</span>
        {{ " " }}{{ actionVerb(ev.event) }}{{ " " }}
        <template v-if="ev.ticket">
          <span class="font-mono text-xs text-muted-foreground">{{ ev.ticket.key }}</span>
          <span class="text-foreground">{{ " " }}{{ ev.ticket.title }}</span>
        </template>
      </span>
      <span class="shrink-0 text-[11px] text-muted-foreground tabular-nums">
        {{ formatRelativeTime(ev.occurred_at) }}
      </span>
    </li>
  </ul>
</template>
