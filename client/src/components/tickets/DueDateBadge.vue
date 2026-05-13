<script setup lang="ts">
import { computed } from "vue";
import { Calendar, AlertCircle } from "lucide-vue-next";
import { cn } from "@/lib/utils";

const props = defineProps<{
  dueDate: string | null | undefined;
  // When true the ticket is treated as still open — overdue styling kicks in.
  // Closed tickets show the due date neutrally even if it's past.
  isOpen?: boolean;
  showLabel?: boolean;
}>();

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Date math against local midnight so "due today" / "overdue 1d" line up with
// the user's calendar, not UTC.
function localMidnight(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

const info = computed(() => {
  if (!props.dueDate) return null;
  const due = new Date(props.dueDate);
  if (Number.isNaN(due.getTime())) return null;

  const today = localMidnight(new Date());
  const dueMid = localMidnight(due);
  const diffDays = Math.round((dueMid - today) / MS_PER_DAY);

  const isOverdue = (props.isOpen ?? true) && diffDays < 0;
  const isDueToday = diffDays === 0;
  const isDueSoon = (props.isOpen ?? true) && diffDays > 0 && diffDays <= 7;

  let label: string;
  if (diffDays === 0) label = "Due today";
  else if (diffDays === 1) label = "Due tomorrow";
  else if (diffDays === -1) label = "Overdue 1d";
  else if (diffDays < 0) label = `Overdue ${-diffDays}d`;
  else if (diffDays <= 7) {
    label = `Due ${due.toLocaleDateString(undefined, { weekday: "short" })}`;
  } else {
    label = `Due ${due.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
  }

  const tone = isOverdue
    ? "text-red-500"
    : isDueToday
    ? "text-amber-500"
    : isDueSoon
    ? "text-amber-500/80"
    : "text-muted-foreground";

  return { label, tone, isOverdue, fullTitle: due.toLocaleDateString(undefined, { dateStyle: "full" }) };
});
</script>

<template>
  <span
    v-if="info"
    :class="cn('inline-flex items-center gap-1 text-xs whitespace-nowrap', info.tone)"
    :title="info.fullTitle"
  >
    <AlertCircle v-if="info.isOverdue" class="h-3.5 w-3.5" />
    <Calendar v-else class="h-3.5 w-3.5" />
    <span v-if="showLabel">{{ info.label }}</span>
  </span>
</template>
