<script setup lang="ts">
// "Epics in flight" dashboard card (SWY-142): open epics with SEMANTIC
// progress bars — fill color + label carry state, not just a number.
//
//   stalled  → coral fill, mono "stalled" label (no agent activity within
//              the server's stall window; the footer says how long)
//   planning → purple fill, "plan" (epic not started yet)
//   done     → green fill, "done" (all children closed, epic not closed yet)
//   normal   → blue fill, "N%"

import { computed } from "vue";
import { useRouter } from "vue-router";
import { Flag, AlertTriangle } from "lucide-vue-next";
import { STATUS_HEX } from "@/lib/statusColors";
import { formatCompactRelativeTime } from "@/lib/formatTime";
import { useEpicsInFlight } from "@/composables/useDashboardData";
import DashboardWidget from "@/components/dashboard/DashboardWidget.vue";
import StatusBadge from "@/components/tickets/StatusBadge.vue";
import UserAvatar from "@/components/UserAvatar.vue";

const router = useRouter();
const q = useEpicsInFlight();

const SIGNAL_HEX = "#e2623d"; // --signal; ECharts-style inline hex, same as STATUS_HEX

type EpicState = "stalled" | "planning" | "done" | "normal";

const epics = computed(() =>
  (q.data.value?.items ?? []).map((e) => {
    const state: EpicState = e.stalled
      ? "stalled"
      : e.progress_pct >= 100
        ? "done"
        : e.status.category === "planning" || e.status.category === "backlog"
          ? "planning"
          : "normal";
    return {
      ...e,
      state,
      fillHex: {
        stalled: SIGNAL_HEX,
        planning: STATUS_HEX.planning,
        done: STATUS_HEX.closed,
        normal: STATUS_HEX.in_progress,
      }[state],
      trackLabel: {
        stalled: "stalled",
        planning: "plan",
        done: "done",
        normal: `${e.progress_pct}%`,
      }[state],
      // A zero-progress epic still shows a nub so the track reads as a bar.
      fillPct: Math.max(e.progress_pct, 4),
      stalledDays: e.last_activity_at
        ? Math.max(1, Math.floor((Date.now() - new Date(e.last_activity_at).getTime()) / 86_400_000))
        : null,
    };
  })
);

function open(key: string) {
  router.push(`/tickets/${key}`);
}
</script>

<template>
  <DashboardWidget title="Epics in flight" :loading="q.isLoading.value" :error="q.error.value" :padded="false">
    <template #title-prefix>
      <Flag class="h-3.5 w-3.5 text-muted-foreground" />
    </template>
    <template #actions>
      <span class="eyebrow">open</span>
    </template>

    <div v-if="epics.length === 0" class="py-8 text-center text-xs text-muted-foreground">
      No epics in flight.
    </div>

    <ul v-else class="divide-y divide-border/60">
      <li
        v-for="e in epics"
        :key="e.id"
        class="px-4 py-3 space-y-1.5 cursor-pointer hover:bg-accent/40 transition-colors"
        @click="open(e.key)"
      >
        <div class="flex items-center justify-between gap-2">
          <span class="font-mono text-[11px] text-ink-3">{{ e.key }}</span>
          <StatusBadge :category="e.status.category" :display-name="e.status.display_name" size="sm" />
        </div>

        <div class="text-[13px] font-medium leading-snug">{{ e.title }}</div>

        <div class="flex items-center gap-2">
          <div class="h-[5px] flex-1 overflow-hidden rounded-full bg-surface-4">
            <div
              class="h-full rounded-full"
              :style="{ width: `${e.fillPct}%`, backgroundColor: e.fillHex }"
            />
          </div>
          <span
            class="shrink-0 font-mono text-[10px] tabular-nums"
            :class="e.state === 'stalled' ? 'text-signal-2' : 'text-ink-3'"
          >{{ e.trackLabel }}</span>
        </div>

        <div
          v-if="e.state === 'stalled'"
          class="flex items-center gap-1.5 text-[11px] text-signal-2"
        >
          <AlertTriangle class="h-3 w-3 shrink-0" />
          <span>no LLM activity {{ e.stalledDays ?? "?" }}d — needs you</span>
        </div>
        <div v-else class="flex items-center gap-1.5 text-[11px] text-ink-3">
          <UserAvatar v-if="e.driver" :user="e.driver" size="xs" class="h-4 w-4 text-[7px]" />
          <span v-if="e.state === 'done'">
            shipped · all {{ e.children_total }} children closed
          </span>
          <span v-else-if="e.driver">
            {{ e.driver.name }} driving · active {{ formatCompactRelativeTime(e.last_activity_at) }}
          </span>
          <span v-else>no activity yet</span>
        </div>
      </li>
    </ul>
  </DashboardWidget>
</template>
