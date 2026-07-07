<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, useTemplateRef, ref } from "vue";
import { draggable, dropTargetForElements } from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import {
  attachClosestEdge, extractClosestEdge, type Edge,
} from "@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge";
import { useQuery } from "@tanstack/vue-query";
import { ChevronLeft, ChevronDown, Circle, CheckCircle2, Loader2 } from "lucide-vue-next";
import { api } from "@/lib/api";
import { queryKeys } from "@/lib/queryKeys";
import { formatRelativeTime } from "@/lib/formatTime";
import UserAvatar from "@/components/UserAvatar.vue";
import { cn } from "@/lib/utils";
import TypeIcon from "./TypeIcon.vue";
import PriorityBadge from "./PriorityBadge.vue";
import DueDateBadge from "./DueDateBadge.vue";
import LabelChip from "./LabelChip.vue";
import EpicChip from "./EpicChip.vue";
import DropIndicator from "./DropIndicator.vue";
import ExternalRefBadge from "./ExternalRefBadge.vue";
import type { TicketSummary } from "@switchyard/shared";

const props = defineProps<{
  ticket: TicketSummary;
  // True while a drag-from-this-card is in flight; we dim it for visual feedback.
  dragging?: boolean;
  // True when this card is the column's keyboard-focused card; we ring it.
  focused?: boolean;
  // v4 live state: an agent is actively working this ticket — coral ring.
  // Display-only here; the signal source lands with SWY-147.
  live?: boolean;
}>();

const emit = defineEmits<{
  open: [key: string];
  // Fires when another card is dropped onto THIS card's hit zone. The parent
  // column needs `sourceCategory` to detect cross-column moves — without
  // it, drop-onto-a-card collapses to a same-column reorder even when the
  // source came from a different column.
  drop: [payload: {
    sourceTicketId: string;
    sourceCategory: string;
    edge: "top" | "bottom";
  }];
}>();

const cardEl = useTemplateRef<HTMLElement>("cardEl");
// Currently-hovered edge while another card drags over us, or null otherwise.
const dropEdge = ref<Edge | null>(null);

let cleanups: Array<() => void> = [];

onMounted(() => {
  if (!cardEl.value) return;
  cleanups.push(
    draggable({
      element: cardEl.value,
      // Collapse the subtask panel before a drag so the card reflows back to
      // its compact footprint while moving (Decision 1: auto-collapse on drag).
      onDragStart: () => { expanded.value = false; },
      getInitialData: () => ({
        kind: "ticket-card",
        ticketId: props.ticket.id,
        ticketKey: props.ticket.key,
        currentStatusId: props.ticket.status.id,
        currentCategory: props.ticket.status.category,
        ticketType: props.ticket.type,
      }),
    })
  );
  cleanups.push(
    dropTargetForElements({
      element: cardEl.value,
      // Carry our identity + the closest edge so the parent column can compute
      // the destination index from a single drop event.
      getData: ({ input, element }) =>
        attachClosestEdge(
          {
            kind: "ticket-card-target",
            ticketId: props.ticket.id,
            currentCategory: props.ticket.status.category,
          },
          { input, element, allowedEdges: ["top", "bottom"] }
        ),
      canDrop: ({ source }) => {
        // Only accept other ticket cards, never ourselves.
        return source.data.kind === "ticket-card"
          && source.data.ticketId !== props.ticket.id;
      },
      onDragEnter: ({ self }) => { dropEdge.value = extractClosestEdge(self.data); },
      onDrag: ({ self }) => { dropEdge.value = extractClosestEdge(self.data); },
      onDragLeave: () => { dropEdge.value = null; },
      onDrop: ({ source, self }) => {
        const edge = extractClosestEdge(self.data);
        const sourceTicketId = source.data.ticketId as string | undefined;
        const sourceCategory = source.data.currentCategory as string | undefined;
        dropEdge.value = null;
        if (!sourceTicketId || !edge || !sourceCategory) return;
        emit("drop", {
          sourceTicketId,
          sourceCategory,
          edge: edge === "top" ? "top" : "bottom",
        });
      },
    })
  );
});

onBeforeUnmount(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

// v4 density: cards show at most 2 label chips (+N overflow) — the mock's
// tkt-foot never shows more.
const visibleLabels = computed(() => props.ticket.labels.slice(0, 2));
const extraLabelCount = computed(() => Math.max(0, props.ticket.labels.length - 2));
// Cap visible badges so a ticket with many refs doesn't blow out the
// card. Extras show as a count.
const visibleRefs = computed(() => (props.ticket.external_refs ?? []).slice(0, 4));
const extraRefCount = computed(() =>
  Math.max(0, (props.ticket.external_refs ?? []).length - 4),
);

const ticketOpen = computed(() => props.ticket.status.category !== "closed");
const isOverdue = computed(() => {
  if (!props.ticket.due_date || !ticketOpen.value) return false;
  return new Date(props.ticket.due_date).getTime() < Date.now();
});

// v4 decision (SWY-144): the mock drops priority/due-date chrome from cards
// in favor of live/agent signals. We keep the highest-value slices — the
// priority badge only when it demands attention (high/critical) and the
// due-date badge only when overdue. Full values remain on the ticket views.
const showPriority = computed(
  () => props.ticket.priority === "high" || props.ticket.priority === "critical",
);

// ─── subtask disclosure ─────────────────────────────────────────────────────
// The batched `subtasks` rollup tells us the counts up front (no per-card
// fetch); the actual rows are loaded lazily only when the panel is expanded.
const subtaskCounts = computed(() => props.ticket.subtasks);
const hasSubtasks = computed(() => (subtaskCounts.value?.total ?? 0) > 0);

const expanded = ref(false);
function toggleSubtasks() {
  expanded.value = !expanded.value;
}

const subtasksQuery = useQuery({
  queryKey: computed(() => queryKeys.ticketChildren(props.ticket.id)),
  enabled: computed(() => expanded.value && hasSubtasks.value),
  staleTime: 30 * 1000,
  queryFn: async () => {
    const { data, error } = await api.GET("/v1/tickets/{idOrKey}/children", {
      params: { path: { idOrKey: props.ticket.id } },
    });
    if (error) throw error;
    return data;
  },
});
const subtasks = computed(() => subtasksQuery.data.value?.items ?? []);

// ─── blocked-by chip (v4) ───────────────────────────────────────────────────
// Cards in the Blocked column name their blocker. Scoped to blocked-category
// tickets only (a handful per board at worst), so this stays a per-blocked-
// card query rather than a whole-board N+1; a batched rollup can replace it
// when ticket-activity signals land (SWY-147).
const isBlockedCategory = computed(() => props.ticket.status.category === "blocked");
const linksQuery = useQuery({
  queryKey: computed(() => ["sw", "tickets", props.ticket.id, "links"]),
  enabled: isBlockedCategory,
  staleTime: 60 * 1000,
  queryFn: async () => {
    const { data, error } = await api.GET("/v1/tickets/{idOrKey}/links", {
      params: { path: { idOrKey: props.ticket.id } },
    });
    if (error) throw error;
    return data;
  },
});
const blockedBy = computed(() => {
  if (!isBlockedCategory.value) return null;
  const links = linksQuery.data.value?.items ?? [];
  return links.find((l) => l.type === "blocks" && l.direction === "incoming") ?? null;
});

// Closed cards trade chrome for a "how long ago" read.
const closedAgo = computed(() =>
  props.ticket.status.category === "closed"
    ? formatRelativeTime(props.ticket.updated_at)
    : null,
);
</script>

<template>
  <div
    ref="cardEl"
    role="button"
    tabindex="0"
    :class="cn(
      'relative cursor-grab active:cursor-grabbing select-none',
      'rounded-[9px] border bg-card px-3 py-[11px] text-sm',
      'hover:border-line-strong hover:bg-accent transition-colors',
      live && 'border-signal-line ring-1 ring-signal-weak',
      dragging && 'opacity-40',
      focused && 'ring-2 ring-ring ring-offset-1',
      isOverdue && 'border-l-2 border-l-neg/70',
    )"
    @click="emit('open', ticket.key)"
    @keydown.enter="emit('open', ticket.key)"
  >
    <DropIndicator v-if="dropEdge === 'top'" edge="top" />
    <DropIndicator v-if="dropEdge === 'bottom'" edge="bottom" />

    <!-- tkt-top: hue-colored type icon + mono key, right-pushed slot (epic
         chip / refs / attention-priority). -->
    <div class="flex items-center gap-[7px] text-[10.5px] text-ink-3 mb-2">
      <TypeIcon :type="ticket.type" class="h-3.5 w-3.5" />
      <span class="font-mono">{{ ticket.key }}</span>
      <span class="ml-auto flex items-center gap-1.5">
        <EpicChip v-if="ticket.parent" :parent="ticket.parent" />
        <template v-if="visibleRefs.length > 0">
          <ExternalRefBadge v-for="r in visibleRefs" :key="r.id" :value="r" size="xs" />
          <span v-if="extraRefCount > 0" class="text-[10px]">+{{ extraRefCount }}</span>
        </template>
        <PriorityBadge v-if="showPriority" :priority="ticket.priority" />
      </span>
    </div>
    <p class="text-[12.5px] font-medium leading-[1.42] line-clamp-3 text-foreground">
      {{ ticket.title }}
    </p>
    <!-- Blocked column: name the blocker (click-through opens it). -->
    <button
      v-if="blockedBy"
      type="button"
      class="mt-2 inline-flex h-[19px] items-center gap-1 rounded-[5px] bg-muted px-1.5 font-mono text-[10px] text-muted-foreground hover:text-foreground transition-colors"
      :title="`Blocked by ${blockedBy.other_ticket.key} — ${blockedBy.other_ticket.title}`"
      @click.stop="emit('open', blockedBy.other_ticket.key)"
    >
      blocked by <span class="text-st-blocked">{{ blockedBy.other_ticket.key }}</span>
    </button>

    <!-- tkt-foot: ≤2 label chips left, overdue badge, driver avatar right. -->
    <div
      v-if="visibleLabels.length > 0 || ticket.assignee || isOverdue || closedAgo"
      class="flex items-center gap-1.5 mt-2.5"
    >
      <div class="flex flex-wrap gap-1.5 flex-1 min-w-0 items-center">
        <LabelChip v-for="lbl in visibleLabels" :key="lbl.id" :label="lbl" />
        <span v-if="extraLabelCount > 0" class="text-[10px] text-muted-foreground self-center">
          +{{ extraLabelCount }}
        </span>
        <DueDateBadge
          v-if="isOverdue"
          :due-date="ticket.due_date"
          :is-open="ticketOpen"
          show-label
        />
      </div>
      <span v-if="closedAgo" class="font-mono text-[10px] text-ink-4 whitespace-nowrap">
        {{ closedAgo }}
      </span>
      <UserAvatar v-if="ticket.assignee" :user="ticket.assignee" size="xs" class="shrink-0" />
    </div>

    <!-- Subtask disclosure: bottom-left caret (left=collapsed / down=expanded)
         with an N/M done glance when collapsed. Inline panel reflows the cards
         below it; the indicator is display-only (Decision 1). -->
    <template v-if="hasSubtasks">
      <button
        type="button"
        class="mt-2 flex items-center gap-1 rounded px-1 -ml-1 py-0.5 text-muted-foreground hover:text-foreground hover:bg-accent/40 transition-colors cursor-pointer"
        :aria-expanded="expanded"
        :title="expanded ? 'Hide subtasks' : 'Show subtasks'"
        @click.stop="toggleSubtasks"
        @keydown.enter.stop="toggleSubtasks"
        @keydown.space.prevent.stop="toggleSubtasks"
      >
        <component :is="expanded ? ChevronDown : ChevronLeft" class="h-3.5 w-3.5" />
        <span v-if="!expanded" class="text-[10px] font-medium tabular-nums">
          {{ subtaskCounts!.done }}/{{ subtaskCounts!.total }}
        </span>
      </button>

      <div v-if="expanded" class="mt-1 w-4/5 space-y-0.5" @click.stop>
        <div v-if="subtasksQuery.isLoading.value" class="flex items-center gap-1.5 px-1.5 py-1 text-xs text-muted-foreground">
          <Loader2 class="h-3 w-3 animate-spin" /> Loading…
        </div>
        <button
          v-for="s in subtasks"
          :key="s.id"
          type="button"
          class="flex w-full items-center gap-1.5 rounded border bg-background/60 px-1.5 py-1 text-left text-xs hover:bg-accent/40 transition-colors cursor-pointer"
          @click.stop="emit('open', s.key)"
        >
          <span class="font-mono text-[10px] text-muted-foreground shrink-0">{{ s.key }}</span>
          <span class="flex-1 min-w-0 truncate">{{ s.title }}</span>
          <CheckCircle2
            v-if="s.status.category === 'closed'"
            class="h-3.5 w-3.5 shrink-0 text-st-closed"
            aria-label="Done"
          />
          <Circle
            v-else
            class="h-3.5 w-3.5 shrink-0 text-muted-foreground/60"
            aria-label="Not done"
          />
        </button>
      </div>
    </template>
  </div>
</template>
