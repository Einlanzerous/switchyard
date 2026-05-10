<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, useTemplateRef, ref } from "vue";
import { draggable, dropTargetForElements } from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import {
  attachClosestEdge, extractClosestEdge, type Edge,
} from "@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge";
import UserAvatar from "@/components/UserAvatar.vue";
import { cn } from "@/lib/utils";
import TypeIcon from "./TypeIcon.vue";
import PriorityBadge from "./PriorityBadge.vue";
import LabelChip from "./LabelChip.vue";
import DropIndicator from "./DropIndicator.vue";
import type { TicketSummary } from "@switchyard/shared";

const props = defineProps<{
  ticket: TicketSummary;
  // True while a drag-from-this-card is in flight; we dim it for visual feedback.
  dragging?: boolean;
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

const visibleLabels = computed(() => props.ticket.labels.slice(0, 3));
const extraLabelCount = computed(() => Math.max(0, props.ticket.labels.length - 3));
</script>

<template>
  <div
    ref="cardEl"
    role="button"
    tabindex="0"
    :class="cn(
      'relative cursor-grab active:cursor-grabbing select-none',
      'rounded-md border bg-card p-2.5 text-sm shadow-sm',
      'hover:border-primary/50 hover:shadow-md transition-shadow',
      dragging && 'opacity-40',
    )"
    @click="emit('open', ticket.key)"
    @keydown.enter="emit('open', ticket.key)"
  >
    <DropIndicator v-if="dropEdge === 'top'" edge="top" />
    <DropIndicator v-if="dropEdge === 'bottom'" edge="bottom" />

    <div class="flex items-center gap-1.5 text-xs text-muted-foreground mb-1">
      <TypeIcon :type="ticket.type" class="h-3.5 w-3.5" />
      <span class="font-mono">{{ ticket.key }}</span>
      <PriorityBadge :priority="ticket.priority" class="ml-auto" />
    </div>
    <p class="font-medium leading-snug line-clamp-3 text-foreground">
      {{ ticket.title }}
    </p>
    <div
      v-if="visibleLabels.length > 0 || ticket.assignee"
      class="flex items-center gap-1.5 mt-2"
    >
      <div class="flex flex-wrap gap-1 flex-1 min-w-0">
        <LabelChip v-for="lbl in visibleLabels" :key="lbl.id" :label="lbl" />
        <span v-if="extraLabelCount > 0" class="text-[10px] text-muted-foreground self-center">
          +{{ extraLabelCount }}
        </span>
      </div>
      <UserAvatar v-if="ticket.assignee" :user="ticket.assignee" size="xs" class="shrink-0" />
    </div>
  </div>
</template>
