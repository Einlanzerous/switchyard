<script setup lang="ts">
import { computed } from "vue";
import { cn } from "@/lib/utils";

// Covers both PlanStatus (draft|in_review|changes_requested|approved|superseded)
// and PlanRevisionStatus (in_review|changes_requested|approved|rejected) — the
// two enums overlap, so one tone map serves both the plan pill and per-revision
// rows. Tones mirror the StatusBadge palette (border + tinted bg + text).
const props = defineProps<{
  status: string;
  size?: "sm" | "md";
}>();

const TONE: Record<string, string> = {
  draft: "border-zinc-300 bg-zinc-100 text-zinc-600 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
  in_review: "border-amber-300 bg-amber-100 text-amber-700 dark:border-amber-800/60 dark:bg-amber-950/50 dark:text-amber-300",
  changes_requested: "border-orange-300 bg-orange-100 text-orange-700 dark:border-orange-800/60 dark:bg-orange-950/50 dark:text-orange-300",
  approved: "border-green-300 bg-green-100 text-green-700 dark:border-green-800/60 dark:bg-green-950/50 dark:text-green-300",
  rejected: "border-red-300 bg-red-100 text-red-700 dark:border-red-800/60 dark:bg-red-950/50 dark:text-red-300",
  superseded: "border-zinc-300 bg-zinc-100 text-zinc-500 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-400",
};

const LABEL: Record<string, string> = {
  draft: "Draft",
  in_review: "In review",
  changes_requested: "Changes requested",
  approved: "Approved",
  rejected: "Rejected",
  superseded: "Superseded",
};

const tone = computed(() => TONE[props.status] ?? TONE.draft);
const label = computed(() => LABEL[props.status] ?? props.status.replace(/_/g, " "));
</script>

<template>
  <span
    :class="cn(
      'inline-flex items-center rounded-md border font-medium whitespace-nowrap',
      size === 'sm' ? 'h-5 px-1.5 text-[10px]' : 'h-6 px-2 text-xs',
      tone,
    )"
  >
    {{ label }}
  </span>
</template>
