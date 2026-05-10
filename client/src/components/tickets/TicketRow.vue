<script setup lang="ts">
import { computed } from "vue";
import { formatDistanceToNow } from "date-fns";
import UserAvatar from "@/components/UserAvatar.vue";
import { Checkbox } from "@/components/ui/checkbox";
import StatusBadge from "./StatusBadge.vue";
import PriorityBadge from "./PriorityBadge.vue";
import TypeIcon from "./TypeIcon.vue";
import LabelChip from "./LabelChip.vue";
import { cn } from "@/lib/utils";
import type { TicketSummary } from "@switchyard/shared";

const props = defineProps<{
  ticket: TicketSummary;
  // True when the URL `?focus=KEY` matches this row (drawer is open on it).
  active?: boolean;
  // True when this row is the bulk-select target (checkbox checked).
  selected?: boolean;
  // True when keyboard nav has parked on this row. Renders a left-edge
  // accent so users tracking the list with arrow keys / j-k can see where
  // they are without it looking the same as the drawer-open state.
  focused?: boolean;
}>();

const emit = defineEmits<{
  open: [key: string];
  // Bulk-select toggle. Receives the modifier so the parent can implement
  // shift-click range selection without re-listening to the underlying
  // mouse event.
  toggleSelect: [key: string, withRange: boolean];
}>();

const updatedRel = computed(() => {
  try {
    return formatDistanceToNow(new Date(props.ticket.updated_at), { addSuffix: true });
  } catch {
    return "—";
  }
});

const visibleLabels = computed(() => props.ticket.labels.slice(0, 3));
const extraLabelCount = computed(() => Math.max(0, props.ticket.labels.length - 3));

// The checkbox cell needs to stop the click bubbling up to the row button so
// selecting a row doesn't also pop the drawer. Same for the keyboard space
// activation on the checkbox.
function onSelectClick(e: MouseEvent) {
  e.stopPropagation();
  e.preventDefault();
  emit("toggleSelect", props.ticket.key, e.shiftKey);
}
</script>

<template>
  <div
    :class="cn(
      'relative flex h-12 w-full items-center gap-3 pr-4 text-left text-sm border-b border-border/60 transition-colors group',
      'hover:bg-accent/50',
      active && 'bg-accent/70',
      selected && 'bg-primary/5',
      // Focus accent: 2px primary stripe on the left edge. Drawn via
      // before-pseudo so it doesn't push content rightward.
      focused && 'before:absolute before:inset-y-0 before:left-0 before:w-[2px] before:bg-primary',
    )"
  >
    <!-- Bulk-select cell. Always visible (muted) but clearer on hover and
         when selected. Lives outside the main click-target button so clicks
         here don't trigger the drawer. -->
    <div
      class="flex items-center justify-center pl-4 pr-1 shrink-0"
      @click="onSelectClick"
    >
      <Checkbox
        :model-value="!!selected"
        :class="cn(
          'transition-opacity',
          selected ? 'opacity-100' : 'opacity-40 group-hover:opacity-100'
        )"
        :aria-label="`Select ${ticket.key}`"
        tabindex="-1"
      />
    </div>

    <!--
      Focus styles intentionally only outline-none — the wrapper above
      already paints the row-wide background based on `active` and
      `selected`, so adding a darker focus:bg-accent here would make the
      button cell light up hotter than the checkbox cell next to it.
    -->
    <button
      type="button"
      class="flex flex-1 min-w-0 items-center gap-3 h-full text-left focus:outline-none"
      @click="emit('open', ticket.key)"
    >
      <span class="font-mono text-xs text-muted-foreground w-20 shrink-0 truncate">{{ ticket.key }}</span>
      <TypeIcon :type="ticket.type" />
      <span class="flex-1 min-w-0 truncate font-medium text-foreground">{{ ticket.title }}</span>

      <div class="hidden md:flex items-center gap-1.5 shrink-0">
        <LabelChip v-for="lbl in visibleLabels" :key="lbl.id" :label="lbl" />
        <span v-if="extraLabelCount > 0" class="text-[10px] text-muted-foreground">+{{ extraLabelCount }}</span>
      </div>

      <PriorityBadge :priority="ticket.priority" class="hidden sm:inline-flex" />
      <StatusBadge :category="ticket.status.category" :display-name="ticket.status.display_name" size="sm" />

      <UserAvatar
        v-if="ticket.assignee"
        :user="ticket.assignee"
        class="hidden sm:flex"
      />
      <div v-else class="h-6 w-6 hidden sm:block" />

      <span class="hidden lg:inline text-xs text-muted-foreground w-32 text-right shrink-0 truncate">
        {{ updatedRel }}
      </span>
    </button>
  </div>
</template>
