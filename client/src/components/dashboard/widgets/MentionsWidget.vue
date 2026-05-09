<script setup lang="ts">
// @mentions widget. v1 is a stateless live-scan — see /v1/users/me/mentions
// for the server side. Clicking opens the mentioning ticket in the drawer
// with the comment surfaced (drawer behavior already supports `?focus=`).

import { useRoute, useRouter } from "vue-router";
import { AtSign, Loader2 } from "lucide-vue-next";
import { useMyMentions } from "@/composables/useDashboardData";
import { formatRelativeTime } from "@/lib/formatTime";

const route = useRoute();
const router = useRouter();
const q = useMyMentions();

function open(key: string) {
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
    <AtSign class="h-5 w-5 mb-1.5 text-muted-foreground/40" />
    All caught up.
  </div>
  <ul v-else class="divide-y divide-border/60 overflow-hidden rounded-b-xl">
    <li
      v-for="m in q.data.value?.items"
      :key="`${m.ticket.id}-${m.comment_id ?? 'desc'}-${m.mentioned_at}`"
      class="px-4 py-2 hover:bg-accent/40 cursor-pointer transition-colors"
      @click="open(m.ticket.key)"
    >
      <div class="flex items-center gap-2 min-w-0">
        <span class="font-mono text-[11px] text-muted-foreground shrink-0">{{ m.ticket.key }}</span>
        <span class="text-sm font-medium truncate">{{ m.ticket.title }}</span>
        <span class="ml-auto shrink-0 text-[11px] text-muted-foreground tabular-nums">
          {{ formatRelativeTime(m.mentioned_at) }}
        </span>
      </div>
      <p class="text-xs text-muted-foreground mt-0.5 truncate">{{ m.snippet }}</p>
    </li>
  </ul>
</template>
