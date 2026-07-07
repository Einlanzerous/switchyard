<script setup lang="ts">
// Compact list of recent events. Click row → opens drawer. Used on the
// Home dashboard. Future: per-project Insights might show a scoped feed.
//
// v4 enrichments (SWY-143): moved rows show "→ {status}" in the target
// category's color, and external-ref events render a PR state chip built
// from the event payload ("#412 merged").

import { computed } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useQuery } from "@tanstack/vue-query";
import { Activity } from "lucide-vue-next";
import type { StatusCategory } from "@switchyard/shared";
import UserAvatar from "@/components/UserAvatar.vue";
import { api } from "@/lib/api";
import { queryKeys } from "@/lib/queryKeys";
import { formatRelativeTime } from "@/lib/formatTime";
import { collapseTransitionEvents } from "@/lib/activity";
import { STATUS_HEX } from "@/lib/statusColors";

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

// Collapse the `status_changed` ("moved") twin a close/release writes alongside
// its terminal event, so one action renders as one line.
const items = computed(() => collapseTransitionEvents(q.data.value?.items ?? []));

function actionVerb(event: string): string {
  switch (event) {
    case "ticket.created": return "created";
    case "ticket.updated": return "updated";
    case "ticket.status_changed": return "moved";
    case "ticket.assigned": return "assigned";
    case "ticket.closed": return "closed";
    case "ticket.released": return "released";
    case "ticket.deleted": return "deleted";
    case "ticket.moved": return "moved";
    case "ticket.link_added": return "linked work to";
    case "ticket.link_removed": return "unlinked work from";
    case "ticket.external_ref_added": return "attached";
    case "ticket.external_ref_removed": return "detached";
    case "ticket.external_ref_state_changed": return "updated";
    case "comment.created": return "commented on";
    case "comment.updated": return "edited a comment on";
    case "comment.deleted": return "removed a comment on";
    case "attachment.added": return "attached a file to";
    case "attachment.removed": return "detached a file from";
    case "project.created": return "created project";
    case "project.updated": return "updated project";
    case "project.deleted": return "deleted project";
    case "plan.submitted": return "submitted a plan for";
    case "plan.revised": return "revised the plan for";
    case "plan.approved": return "approved the plan for";
    case "plan.changes_requested": return "requested plan changes on";
    case "plan.rejected": return "rejected the plan for";
    default: return event;
  }
}

type FeedItem = typeof items.value[number];

// "→ In Progress" target for moved rows, painted in the category color.
function movedTo(ev: FeedItem): { name: string; hex: string } | null {
  if (ev.event !== "ticket.status_changed" && ev.event !== "ticket.moved") return null;
  const to = ev.changes?.status?.to;
  if (!to) return null;
  return { name: to.display_name, hex: STATUS_HEX[to.category as StatusCategory] };
}

// PR chip for external-ref events, built from the writeEvent extras
// ({ kind, url, new_state? }). "#412" comes from the PR/issue URL.
const REF_STATE_HEX: Record<string, string> = {
  merged: STATUS_HEX.closed,
  success: STATUS_HEX.closed,
  open: STATUS_HEX.in_progress,
  closed: STATUS_HEX.blocked,
  failed: STATUS_HEX.blocked,
};

function refChip(ev: FeedItem): { label: string; hex: string } | null {
  if (!ev.event.startsWith("ticket.external_ref_")) return null;
  const payload = (ev.payload ?? {}) as Record<string, unknown>;
  const url = typeof payload.url === "string" ? payload.url : "";
  const num = /\/(?:pull|issues)\/(\d+)/.exec(url)?.[1];
  const state =
    ev.event === "ticket.external_ref_state_changed" && typeof payload.new_state === "string"
      ? payload.new_state
      : null;
  const label = [num ? `#${num}` : "PR", state].filter(Boolean).join(" ");
  return { label, hex: (state && REF_STATE_HEX[state]) || STATUS_HEX.backlog };
}

function open(item: FeedItem) {
  if (!item.ticket?.key) return;
  router.replace({ query: { ...route.query, focus: item.ticket.key } });
}
</script>

<template>
  <!-- Skeleton at real row metrics so loading → loaded doesn't jump the
       bounded window the dashboard wraps this feed in (SWY-160). -->
  <div v-if="q.isLoading.value" class="divide-y divide-border/60">
    <div v-for="n in 9" :key="n" class="flex items-center gap-3 px-4 py-2.5">
      <div class="h-6 w-6 shrink-0 rounded-full bg-muted/50" />
      <div class="h-3.5 flex-1 rounded bg-muted/50" />
      <div class="h-3 w-10 shrink-0 rounded bg-muted/50" />
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
        <span
          v-if="refChip(ev)"
          class="mr-1 inline-flex items-center rounded bg-surface-4 px-1.5 py-px font-mono text-[10.5px] font-semibold align-[1px]"
          :style="{ color: refChip(ev)!.hex }"
        >{{ refChip(ev)!.label }}</span>
        <template v-if="ev.event.startsWith('ticket.external_ref_')">{{ "on " }}</template>
        <template v-if="ev.ticket">
          <span class="font-mono text-xs text-muted-foreground">{{ ev.ticket.key }}</span>
          <span class="text-foreground">{{ " " }}{{ ev.ticket.title }}</span>
        </template>
        <span v-if="movedTo(ev)" class="whitespace-nowrap">
          {{ " → " }}
          <span class="font-medium" :style="{ color: movedTo(ev)!.hex }">{{ movedTo(ev)!.name }}</span>
        </span>
      </span>
      <span class="shrink-0 text-[11px] text-muted-foreground tabular-nums">
        {{ formatRelativeTime(ev.occurred_at) }}
      </span>
    </li>
  </ul>
</template>
