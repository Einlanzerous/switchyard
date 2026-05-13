<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, useTemplateRef } from "vue";
import { dropTargetForElements } from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import BoardCard from "./BoardCard.vue";
import type { BoardColumn as Col } from "@/composables/useProjectBoard";
import { positionBetween } from "@/lib/positions";
import { cn } from "@/lib/utils";

const props = defineProps<{
  column: Col;
  draggingTicketId: string | null;
  // Optional: ticket id that has keyboard-focus inside this column. Used
  // by the parent board view to drive arrow-key navigation. Cards
  // compare their own id against this and render the focus stripe
  // accordingly.
  focusedTicketId?: string | null;
  // Optional small grey label rendered next to the column count. The
  // Closed column uses this to show its visibility window
  // ("last 14 days") so the truncation is visible.
  hint?: string;
}>();

// `drop` fires when the destination has been resolved. The parent gets
// (ticketId, toCategory, toStatusId, position) and dispatches the right API
// call (PATCH for same-column reorder, /transition for category change).
const emit = defineEmits<{
  open: [key: string];
  drop: [payload: {
    ticketId: string;
    fromCategory: Col["category"];
    toCategory: Col["category"];
    toStatusId: string;
    // Computed position (fractional index between neighbors, or top/bottom of
    // the column).
    position: number;
  }];
}>();

const dropEl = useTemplateRef<HTMLElement>("dropEl");
const isOver = ref(false);

// Compute a position based on which card was hit and which edge.
// Wrapper for the cleaner downstream emit. `sourceCategory` is supplied by
// the dragging card's drag-source data — without it we can't distinguish
// a cross-column drop-onto-a-card from a same-column reorder, and the
// handler upstream silently degrades to PATCHing position only.
function emitDropForCard(
  sourceTicketId: string,
  sourceCategory: Col["category"],
  targetTicketId: string,
  edge: "top" | "bottom"
) {
  const idx = props.column.tickets.findIndex((t) => t.id === targetTicketId);
  if (idx < 0) return;
  const target = props.column.tickets[idx]!;
  // Tickets are sorted highest-position first. "Top" = closer to index 0.
  const before = edge === "top" ? props.column.tickets[idx - 1] ?? null : target;
  const after = edge === "top" ? target : props.column.tickets[idx + 1] ?? null;
  const position = positionBetween(before, after);

  emit("drop", {
    ticketId: sourceTicketId,
    fromCategory: sourceCategory,
    toCategory: props.column.category,
    toStatusId: props.column.dropTargetStatusId,
    position,
  });
}

let cleanup: (() => void) | null = null;

onMounted(() => {
  if (!dropEl.value) return;
  cleanup = dropTargetForElements({
    element: dropEl.value,
    getData: () => ({ kind: "board-column", category: props.column.category }),
    canDrop: ({ source }) => source.data.kind === "ticket-card",
    // Only highlight the column when the drop would actually land here AT
    // THE BOTTOM (no card hit). When the cursor is on a child card, that
    // card's drop indicator takes over and we don't double-glow the column.
    onDragEnter: ({ source }) => {
      if (source.data.currentCategory !== props.column.category) {
        isOver.value = true;
      }
    },
    onDragLeave: () => { isOver.value = false; },
    onDrop: ({ source, location }) => {
      isOver.value = false;
      const sourceTicketId = source.data.ticketId as string | undefined;
      const fromCategory = source.data.currentCategory as Col["category"] | undefined;
      if (!sourceTicketId || !fromCategory) return;

      // Did the drop land on a child card? If so the card's own onDrop has
      // already fired its `card-drop` event and we let that path handle it.
      const hitCard = location.current.dropTargets
        .some((t) => t.data.kind === "ticket-card-target");
      if (hitCard) return;

      // Empty-area drop ⇒ append to the bottom of this column.
      const last = props.column.tickets[props.column.tickets.length - 1] ?? null;
      const position = positionBetween(last, null);
      emit("drop", {
        ticketId: sourceTicketId,
        fromCategory,
        toCategory: props.column.category,
        toStatusId: props.column.dropTargetStatusId,
        position,
      });
    },
  });
});

onBeforeUnmount(() => {
  cleanup?.();
  cleanup = null;
});

function onCardDrop(
  targetTicketId: string,
  payload: { sourceTicketId: string; sourceCategory: string; edge: "top" | "bottom" }
) {
  emitDropForCard(
    payload.sourceTicketId,
    payload.sourceCategory as Col["category"],
    targetTicketId,
    payload.edge
  );
}
</script>

<template>
  <div
    ref="dropEl"
    :class="cn(
      'flex flex-col rounded-lg border bg-muted/20 transition-colors',
      'min-h-[12rem] w-72 shrink-0',
      isOver && 'border-primary bg-primary/5',
    )"
  >
    <header class="flex items-center justify-between px-3 py-2 border-b sticky top-0 bg-muted/40 backdrop-blur rounded-t-lg z-10">
      <span class="text-xs font-medium uppercase tracking-wider text-foreground">
        {{ column.displayName }}
      </span>
      <span class="flex items-center gap-1.5">
        <span v-if="hint" class="text-[10px] text-muted-foreground italic">{{ hint }}</span>
        <span class="text-[11px] text-muted-foreground tabular-nums">
          {{ column.tickets.length }}
        </span>
      </span>
    </header>
    <div class="flex-1 overflow-y-auto p-2 space-y-2">
      <BoardCard
        v-for="t in column.tickets"
        :key="t.id"
        :ticket="t"
        :dragging="draggingTicketId === t.id"
        :focused="focusedTicketId === t.id"
        @open="(k) => $emit('open', k)"
        @drop="(p) => onCardDrop(t.id, p)"
      />
      <p
        v-if="column.tickets.length === 0"
        class="text-xs text-muted-foreground/60 italic text-center py-4"
      >
        Drop tickets here
      </p>
    </div>
  </div>
</template>
