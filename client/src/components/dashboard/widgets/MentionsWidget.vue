<script setup lang="ts">
// @mentions widget on the homepage. As of 3.3 this reads from the
// persistent notifications endpoint. Self-contained: owns its
// DashboardWidget chrome so the title-suffix count can be a clickable
// router-link and the time-window selector can live in the actions slot.
//
// Behavior:
//   - Window: configurable per-user (24h / 3d / 7d / 14d / 30d), default
//     14d, persisted to localStorage so the choice survives reloads.
//   - Badge in title: total mentions in the window, regardless of read
//     state. Clicking it routes to /tickets?assignee=me — the user
//     specifically wanted that quick path even when they've cleared the
//     unread list.
//   - Body: shows the up-to-8 most recent UNREAD mentions. Click marks
//     read + opens drawer.

import { computed, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { AtSign, Loader2 } from "lucide-vue-next";
import { useNotifications, useMarkOneRead } from "@/composables/useNotifications";
import { useAuthStore } from "@/stores/auth";
import { formatRelativeTime } from "@/lib/formatTime";
import DashboardWidget from "@/components/dashboard/DashboardWidget.vue";
import type { Notification } from "@switchyard/shared";

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();

// ─── window selector ───────────────────────────────────────────────────────
//
// Options expressed in days; "1" doubles for 24h. Stored as the raw string
// so the dropdown defaults stay stable across reloads.
const WINDOW_OPTIONS = [
  { value: "1", label: "24h", days: 1 },
  { value: "3", label: "3d", days: 3 },
  { value: "7", label: "7d", days: 7 },
  { value: "14", label: "14d", days: 14 },
  { value: "30", label: "30d", days: 30 },
];

const STORAGE_KEY = "sw.mentions.window";

const windowDays = ref<string>(
  (typeof window !== "undefined" && localStorage.getItem(STORAGE_KEY)) || "14"
);

function setWindow(v: string) {
  windowDays.value = v;
  if (typeof window !== "undefined") localStorage.setItem(STORAGE_KEY, v);
}

const sinceIso = computed(() => {
  const days = Number(windowDays.value) || 14;
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
});

// ─── data ──────────────────────────────────────────────────────────────────
//
// One query for the whole widget — status=all + since means we get every
// mention in the window. Badge counts the total; body filters to unread
// for the actionable list.
const q = useNotifications({
  status: "all",
  limit: 50,
  since: sinceIso,
});
const markOne = useMarkOneRead();

const all = computed<Notification[]>(() => (q.data.value?.items ?? []) as Notification[]);
const totalCount = computed(() => all.value.length);
const unread = computed(() => all.value.filter((n) => !n.read_at).slice(0, 8));

function openTicket(n: Notification) {
  if (n.ticket?.key) {
    router.replace({ query: { ...route.query, focus: n.ticket.key } });
  }
  if (!n.read_at) markOne.mutate(n.id);
}

// Title-suffix click: jump to /tickets?assignee=<me>. The user wanted this
// to act as a quick path to "what should I work on" — broader than just
// mentions.
function goToMyTickets() {
  if (!auth.me?.id) return;
  router.push(`/tickets?assignee=${auth.me.id}`);
}
</script>

<template>
  <DashboardWidget title="Mentions" :padded="false">
    <template #title-prefix>
      <AtSign class="h-3.5 w-3.5 text-muted-foreground" />
    </template>
    <template #title-suffix>
      <button
        type="button"
        class="ml-1 inline-flex items-center justify-center min-w-[1.5rem] h-5 px-1 rounded text-[10px] font-medium tabular-nums text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
        :title="`${totalCount} mention${totalCount === 1 ? '' : 's'} in the last ${windowDays}d — click to see your tickets`"
        @click="goToMyTickets"
      >
        {{ totalCount }}
      </button>
    </template>
    <template #actions>
      <!-- Native select keeps the visual weight low for a card-header
           control. Bigger shadcn Select would dominate the title row. -->
      <select
        :value="windowDays"
        :aria-label="'Mentions window'"
        class="h-6 px-1.5 text-[11px] rounded border bg-transparent text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring hover:bg-accent/40"
        @change="(e) => setWindow((e.target as HTMLSelectElement).value)"
      >
        <option v-for="o in WINDOW_OPTIONS" :key="o.value" :value="o.value">
          {{ o.label }}
        </option>
      </select>
    </template>

    <div v-if="q.isLoading.value" class="flex items-center justify-center py-6 text-xs text-muted-foreground">
      <Loader2 class="h-3.5 w-3.5 animate-spin mr-1.5" /> Loading
    </div>
    <div
      v-else-if="unread.length === 0"
      class="flex flex-col items-center justify-center py-6 text-xs text-muted-foreground"
    >
      <AtSign class="h-5 w-5 mb-1.5 text-muted-foreground/40" />
      All caught up.
    </div>
    <ul v-else class="divide-y divide-border/60 overflow-hidden rounded-b-xl">
      <li
        v-for="n in unread"
        :key="n.id"
        class="px-4 py-2 hover:bg-accent/40 cursor-pointer transition-colors"
        @click="openTicket(n)"
      >
        <div class="flex items-center gap-2 min-w-0">
          <span
            class="h-1.5 w-1.5 rounded-full bg-rose-500 shrink-0"
            aria-hidden="true"
          />
          <span v-if="n.ticket" class="font-mono text-[11px] text-muted-foreground shrink-0">{{ n.ticket.key }}</span>
          <span class="text-sm font-medium truncate">{{ n.ticket?.title ?? "(deleted ticket)" }}</span>
          <span class="ml-auto shrink-0 text-[11px] text-muted-foreground tabular-nums">
            {{ formatRelativeTime(n.created_at) }}
          </span>
        </div>
        <p class="text-xs text-muted-foreground mt-0.5 truncate">{{ n.payload.snippet }}</p>
      </li>
    </ul>
  </DashboardWidget>
</template>
