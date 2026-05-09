<script setup lang="ts">
// Topbar bell. Shows a red badge when there are unread notifications.
// Clicking opens a popover with the most recent unread by default; a
// "Show all" toggle switches to the recent-all view. Each row marks read
// on click and routes to the source ticket via ?focus=KEY.

import { computed, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { Bell, BellRing, AtSign, CheckCheck } from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import {
  Popover, PopoverContent, PopoverTrigger,
} from "@/components/ui/popover";
import {
  useNotifications, useUnreadCount, useMarkOneRead, useMarkRead,
} from "@/composables/useNotifications";
import { formatRelativeTime } from "@/lib/formatTime";
import type { Notification } from "@switchyard/shared";

const route = useRoute();
const router = useRouter();

const open = ref(false);
const showAll = ref(false);

const unreadQ = useUnreadCount();
const unreadCount = computed(() => unreadQ.data.value?.count ?? 0);

const status = computed<"unread" | "all">(() => (showAll.value ? "all" : "unread"));
const listQ = useNotifications({ status: status.value, limit: 10 });
// Re-fetch when the toggle flips by computing the queryKey via the
// composable's reactive params; useNotifications already keys on the args.
const items = computed<Notification[]>(() => (listQ.data.value?.items ?? []) as Notification[]);

const markOne = useMarkOneRead();
const markAll = useMarkRead();

function clickRow(n: Notification) {
  // Optimistic: close the popover, navigate, then fire-and-forget the
  // mark-as-read so the bell badge updates as soon as the cache invalidates.
  open.value = false;
  if (n.ticket?.key) {
    router.replace({ query: { ...route.query, focus: n.ticket.key } });
  }
  if (!n.read_at) markOne.mutate(n.id);
}

function clickMarkAll() {
  markAll.mutate({ all: true });
}

// Reactive useNotifications: when showAll flips, the composable re-runs
// because its queryKey includes status. We keep the params stable via
// computed-style usage above (the wrapper doesn't take a ref today, so
// re-call when toggling).
function toggleShowAll() {
  showAll.value = !showAll.value;
  listQ.refetch();
}
</script>

<template>
  <Popover v-model:open="open">
    <PopoverTrigger as-child>
      <Button
        variant="ghost"
        size="icon"
        class="relative"
        aria-label="Notifications"
      >
        <component
          :is="unreadCount > 0 ? BellRing : Bell"
          class="h-4 w-4"
        />
        <!-- Red dot + count badge. Two thresholds: 1 = simple dot, ≥2 = number. -->
        <span
          v-if="unreadCount > 0"
          class="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 px-1 rounded-full bg-rose-500 text-[10px] font-semibold text-white flex items-center justify-center tabular-nums"
        >
          {{ unreadCount > 9 ? "9+" : unreadCount }}
        </span>
      </Button>
    </PopoverTrigger>
    <PopoverContent align="end" class="w-80 p-0">
      <div class="flex items-center justify-between px-3 py-2 border-b">
        <div class="text-sm font-medium tracking-tight">
          Notifications
        </div>
        <Button
          v-if="unreadCount > 0"
          variant="ghost"
          size="sm"
          class="h-6 text-xs text-muted-foreground"
          @click="clickMarkAll"
        >
          <CheckCheck class="h-3 w-3 mr-1" /> Mark all read
        </Button>
      </div>

      <div v-if="listQ.isLoading.value" class="p-4 text-xs text-muted-foreground italic">
        Loading…
      </div>

      <div
        v-else-if="items.length === 0"
        class="flex flex-col items-center justify-center py-8 px-3 text-xs text-muted-foreground"
      >
        <AtSign class="h-5 w-5 mb-1.5 text-muted-foreground/40" />
        All caught up.
      </div>

      <ul v-else class="divide-y divide-border/60 max-h-96 overflow-y-auto">
        <li
          v-for="n in items"
          :key="n.id"
          class="px-3 py-2.5 cursor-pointer hover:bg-accent/40 transition-colors"
          :class="!n.read_at && 'bg-primary/5'"
          @click="clickRow(n)"
        >
          <div class="flex items-center gap-2 min-w-0">
            <span
              v-if="!n.read_at"
              class="h-1.5 w-1.5 rounded-full bg-rose-500 shrink-0"
              aria-hidden="true"
            />
            <span class="text-sm font-medium truncate flex-1 min-w-0">
              <span class="text-foreground">{{ n.actor?.name ?? "system" }}</span>
              <span class="text-muted-foreground">
                {{ " " }}mentioned you
                <template v-if="n.payload.source === 'description'"> in a description</template>
              </span>
            </span>
            <span class="ml-auto shrink-0 text-[11px] text-muted-foreground tabular-nums">
              {{ formatRelativeTime(n.created_at) }}
            </span>
          </div>
          <div v-if="n.ticket" class="text-xs text-muted-foreground mt-0.5 truncate">
            <span class="font-mono">{{ n.ticket.key }}</span>
            <span class="ml-1">{{ n.ticket.title }}</span>
          </div>
          <p class="text-xs text-muted-foreground mt-0.5 truncate">{{ n.payload.snippet }}</p>
        </li>
      </ul>

      <div class="border-t px-3 py-1.5 text-center">
        <button
          type="button"
          class="text-[11px] text-muted-foreground hover:text-foreground transition-colors"
          @click="toggleShowAll"
        >
          {{ showAll ? "Show unread only" : "Show all" }}
        </button>
      </div>
    </PopoverContent>
  </Popover>
</template>
