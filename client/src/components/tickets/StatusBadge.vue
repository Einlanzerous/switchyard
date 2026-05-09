<script setup lang="ts">
import { computed } from "vue";
import { cn } from "@/lib/utils";
import type { StatusCategory } from "@switchyard/shared";

const props = defineProps<{
  category: StatusCategory;
  displayName?: string;
  size?: "sm" | "md";
}>();

// Tone per canonical category. Display names can be aliased per-project but
// the color always tracks the underlying category so the meaning stays stable.
const tones: Record<StatusCategory, string> = {
  backlog: "bg-muted text-muted-foreground border-transparent",
  planning: "bg-blue-500/15 text-blue-600 dark:text-blue-300 border-blue-500/30",
  in_progress: "bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30",
  blocked: "bg-red-500/15 text-red-600 dark:text-red-300 border-red-500/30",
  closed: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30",
};

const tone = computed(() => tones[props.category]);
const label = computed(() => props.displayName ?? props.category.replace("_", " "));
</script>

<template>
  <span
    :class="cn(
      'inline-flex items-center rounded-md border font-medium capitalize whitespace-nowrap',
      size === 'sm' ? 'h-5 px-1.5 text-[10px]' : 'h-6 px-2 text-xs',
      tone,
    )"
  >
    {{ label }}
  </span>
</template>
