<script setup lang="ts">
// "Plans awaiting your review" — the homepage review queue. Mirrors ActivityFeed:
// owns its query, renders compact rows, and a click opens the ticket drawer on
// the Plan tab (?focus=KEY&tab=plan). Lists in-review plans in projects the user
// can write (server-scoped via awaiting_my_review).

import { computed } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useQuery } from "@tanstack/vue-query";
import { ClipboardCheck } from "lucide-vue-next";
import UserAvatar from "@/components/UserAvatar.vue";
import TypeIcon from "@/components/tickets/TypeIcon.vue";
import { api } from "@/lib/api";
import { queryKeys } from "@/lib/queryKeys";
import { formatRelativeTime } from "@/lib/formatTime";

const props = defineProps<{
  limit?: number;
}>();

const route = useRoute();
const router = useRouter();

const params = computed(() => ({ awaiting_my_review: true, limit: props.limit ?? 8 }));

const q = useQuery({
  queryKey: queryKeys.plans(params.value),
  staleTime: 30 * 1000,
  queryFn: async () => {
    const { data, error } = await api.GET("/v1/plans", {
      params: { query: params.value as never },
    });
    if (error) throw error;
    return data;
  },
});

const items = computed(() => q.data.value?.items ?? []);

function open(ticketKey: string) {
  router.replace({ query: { ...route.query, focus: ticketKey, tab: "plan" } });
}
</script>

<template>
  <div v-if="q.isLoading.value" class="space-y-2 p-2">
    <div v-for="n in 3" :key="n" class="flex items-center gap-2 px-1">
      <div class="h-6 w-6 rounded-full bg-muted/50" />
      <div class="flex-1 h-4 bg-muted/50 rounded" />
    </div>
  </div>
  <div
    v-else-if="items.length === 0"
    class="flex flex-col items-center justify-center py-6 text-xs text-muted-foreground"
  >
    <ClipboardCheck class="h-5 w-5 mb-1.5 text-muted-foreground/40" />
    No plans awaiting your review.
  </div>
  <ul v-else class="divide-y divide-border/60 overflow-hidden rounded-b-xl">
    <li
      v-for="p in items"
      :key="p.id"
      class="flex items-center gap-3 px-4 py-2.5 text-sm hover:bg-accent/40 transition-colors cursor-pointer"
      @click="open(p.ticket.key)"
    >
      <UserAvatar :user="p.current_revision.submitted_by" class="shrink-0" />
      <span class="flex-1 min-w-0">
        <span class="flex items-center gap-1.5 min-w-0">
          <TypeIcon :type="p.ticket.type" class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span class="font-mono text-xs text-muted-foreground shrink-0">{{ p.ticket.key }}</span>
          <span class="text-foreground truncate">{{ p.ticket.title }}</span>
        </span>
        <span class="text-[11px] text-muted-foreground">
          rev {{ p.current_revision.rev_number }} ·
          {{ p.current_revision.criteria_total }} criteria<template
            v-if="p.current_revision.criteria_pending > 0"
          >, {{ p.current_revision.criteria_pending }} pending</template>
        </span>
      </span>
      <span class="shrink-0 text-[11px] text-muted-foreground tabular-nums">
        {{ formatRelativeTime(p.current_revision.submitted_at) }}
      </span>
    </li>
  </ul>
</template>
