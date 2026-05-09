<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, useTemplateRef } from "vue";
import { dropTargetForElements } from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import BoardCard from "@/components/tickets/BoardCard.vue";
import { positionBetween } from "@/lib/positions";
import { cn } from "@/lib/utils";
import type { TicketSummary, StatusCategory } from "@switchyard/shared";

// One intersection of (swimlane, column). Drop targets are at this level so
// pragmatic-dnd can highlight individual cells under the cursor. Card-level
// drop targets (inside BoardCard) handle precise insert positions; the cell
// itself catches drops in empty space (after the last card or empty cells).
const props = defineProps<{
  category: StatusCategory;
  tickets: TicketSummary[];
  draggingTicketId: string | null;
  showEmptyHint?: boolean;
}>();

const emit = defineEmits<{
  open: [key: string];
  drop: [payload: {
    ticketId: string;
    fromCategory: StatusCategory;
    toCategory: StatusCategory;
    // Computed fractional position within the destination cell.
    position: number;
  }];
}>();

const cellEl = useTemplateRef<HTMLElement>("cellEl");
const isOver = ref(false);
let cleanup: (() => void) | null = null;

function emitForCard(sourceTicketId: string, targetTicketId: string, edge: "top" | "bottom") {
  const idx = props.tickets.findIndex((t) => t.id === targetTicketId);
  if (idx < 0) return;
  const target = props.tickets[idx]!;
  const before = edge === "top" ? props.tickets[idx - 1] ?? null : target;
  const after = edge === "top" ? target : props.tickets[idx + 1] ?? null;
  const position = positionBetween(before, after);

  const sourceTicket = props.tickets.find((t) => t.id === sourceTicketId);
  // For cross-cell drops we don't have the source category in this scope —
  // the parent view resolves it from its full ticket list. We pass through
  // whatever info is available; same-cell reorder still uses our category.
  emit("drop", {
    ticketId: sourceTicketId,
    fromCategory: (sourceTicket?.status.category ?? props.category),
    toCategory: props.category,
    position,
  });
}

onMounted(() => {
  if (!cellEl.value) return;
  cleanup = dropTargetForElements({
    element: cellEl.value,
    getData: () => ({ kind: "board-cell", category: props.category }),
    canDrop: ({ source }) => source.data.kind === "ticket-card",
    onDragEnter: ({ source }) => {
      if (source.data.currentCategory !== props.category) {
        isOver.value = true;
      }
    },
    onDragLeave: () => { isOver.value = false; },
    onDrop: ({ source, location }) => {
      isOver.value = false;
      const fromCategory = source.data.currentCategory as StatusCategory | undefined;
      const ticketId = source.data.ticketId as string | undefined;
      if (!ticketId || !fromCategory) return;

      // Did the drop land on a child card? If so the card's @drop handler has
      // already fired with edge info; don't double-emit.
      const hitCard = location.current.dropTargets
        .some((t) => t.data.kind === "ticket-card-target");
      if (hitCard) return;

      // Empty-cell drop ⇒ append to the bottom of this cell.
      const last = props.tickets[props.tickets.length - 1] ?? null;
      const position = positionBetween(last, null);
      emit("drop", {
        ticketId,
        fromCategory,
        toCategory: props.category,
        position,
      });
    },
  });
});

onBeforeUnmount(() => {
  cleanup?.();
  cleanup = null;
});
</script>

<template>
  <div
    ref="cellEl"
    :class="cn(
      'rounded-md border bg-muted/10 p-1.5 space-y-1.5 min-h-[6rem] transition-colors',
      isOver && 'border-primary bg-primary/5',
    )"
  >
    <BoardCard
      v-for="t in tickets"
      :key="t.id"
      :ticket="t"
      :dragging="draggingTicketId === t.id"
      @open="(k) => emit('open', k)"
      @drop="(p) => emitForCard(p.sourceTicketId, t.id, p.edge)"
    />
    <p
      v-if="tickets.length === 0 && (showEmptyHint ?? true)"
      class="text-[10px] text-muted-foreground/40 italic text-center py-2"
    >
      —
    </p>
  </div>
</template>
