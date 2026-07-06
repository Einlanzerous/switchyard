<script setup lang="ts">
// "Who did the work" leaderboard (SWY-151). Windowed closures credited to
// the ticket's assignee (closing-actor fallback when unassigned — see
// useClosedByActor), so automations that merely execute closes don't absorb
// agent credit. Footer: force multiplier = agent-closed ÷ human-closed over
// the whole window (all rows, not just the visible top).

import { computed } from "vue";
import { useClosedByActor } from "@/composables/useDashboardData";
import { useAuthStore } from "@/stores/auth";
import { Skeleton } from "@/components/ui/skeleton";
import UserAvatar from "@/components/UserAvatar.vue";

const props = defineProps<{
  project?: string;   // CSV of project keys; default = all projects
  since: string;
}>();

const auth = useAuthStore();

const params = computed(() => ({
  project: props.project,
  since: props.since,
  attribute: "assignee" as const,
}));
const q = useClosedByActor(params);

const TOP_N = 7;
const items = computed(() => q.data.value?.items ?? []);
const rows = computed(() => items.value.slice(0, TOP_N));
const maxClosed = computed(() => rows.value[0]?.closed ?? 0);

const agentClosed = computed(() =>
  items.value.filter((i) => i.user.type === "agent").reduce((a, i) => a + i.closed, 0),
);
const humanClosed = computed(() =>
  items.value.filter((i) => i.user.type !== "agent").reduce((a, i) => a + i.closed, 0),
);

// humanClosed = 0 with agent work present reads as "all agents", never a
// division blowup; both zero → the empty state below renders instead.
const multiplierLabel = computed(() => {
  if (humanClosed.value > 0) return `×${(agentClosed.value / humanClosed.value).toFixed(1)}`;
  return agentClosed.value > 0 ? "all agents" : null;
});

const isEmpty = computed(() => !q.isLoading.value && items.value.length === 0);
</script>

<template>
  <div class="px-3 py-2">
    <div v-if="q.isLoading.value" class="space-y-3">
      <Skeleton v-for="i in 4" :key="i" class="h-6 w-full" />
    </div>

    <div v-else-if="isEmpty" class="py-6 text-center text-sm italic text-muted-foreground">
      No closures in this window.
    </div>

    <template v-else>
      <div class="space-y-2.5">
        <div v-for="r in rows" :key="r.user.id" class="flex items-center gap-2.5">
          <UserAvatar :user="r.user" size="sm" />
          <div class="flex items-center gap-1.5 w-28 sm:w-36 shrink-0 min-w-0">
            <span class="truncate text-sm">{{ r.user.name }}</span>
            <span
              v-if="r.user.type === 'agent'"
              class="shrink-0 rounded border border-line bg-agent-bg px-1.5 font-mono text-[10px] text-agent"
            >agent</span>
            <span
              v-else-if="r.user.id === auth.me?.id"
              class="shrink-0 text-[10px] text-ink-3"
            >you</span>
          </div>
          <div class="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-4">
            <div
              class="h-full rounded-full"
              :class="r.user.type === 'agent' ? 'bg-agent' : 'bg-signal'"
              :style="{ width: `${maxClosed ? (r.closed / maxClosed) * 100 : 0}%` }"
            />
          </div>
          <span class="w-9 shrink-0 text-right font-mono text-xs tabular-nums text-ink-2">
            {{ r.closed }}
          </span>
        </div>
      </div>

      <div
        v-if="multiplierLabel"
        class="mt-3 flex items-center justify-between border-t border-line-soft pt-2.5"
      >
        <span class="eyebrow">Force multiplier</span>
        <span class="font-mono text-sm text-signal-2">{{ multiplierLabel }}</span>
      </div>
    </template>
  </div>
</template>
