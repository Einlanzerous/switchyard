<script setup lang="ts">
import { computed } from "vue";
import { formatDistanceToNow } from "date-fns";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import StatusBadge from "./StatusBadge.vue";
import PriorityBadge from "./PriorityBadge.vue";
import TypeIcon from "./TypeIcon.vue";
import LabelChip from "./LabelChip.vue";
import { cn } from "@/lib/utils";
import type { TicketSummary } from "@switchyard/shared";

const props = defineProps<{
  ticket: TicketSummary;
  active?: boolean;
}>();

defineEmits<{
  open: [key: string];
}>();

const updatedRel = computed(() => {
  try {
    return formatDistanceToNow(new Date(props.ticket.updated_at), { addSuffix: true });
  } catch {
    return "—";
  }
});

const assigneeInitials = computed(() => {
  const name = props.ticket.assignee?.name ?? "";
  return name.split(/\s+/).map((p) => p[0]?.toUpperCase() ?? "").slice(0, 2).join("");
});

const visibleLabels = computed(() => props.ticket.labels.slice(0, 3));
const extraLabelCount = computed(() => Math.max(0, props.ticket.labels.length - 3));
</script>

<template>
  <button
    type="button"
    :class="cn(
      'flex h-12 w-full items-center gap-3 px-4 text-left text-sm border-b border-border/60 transition-colors',
      'hover:bg-accent/50 focus:bg-accent focus:outline-none',
      active && 'bg-accent/70',
    )"
    @click="$emit('open', ticket.key)"
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

    <Avatar v-if="ticket.assignee" class="h-6 w-6 hidden sm:flex" :title="ticket.assignee.name">
      <AvatarFallback class="text-[10px]">{{ assigneeInitials }}</AvatarFallback>
    </Avatar>
    <div v-else class="h-6 w-6 hidden sm:block" />

    <span class="hidden lg:inline text-xs text-muted-foreground w-32 text-right shrink-0 truncate">
      {{ updatedRel }}
    </span>
  </button>
</template>
