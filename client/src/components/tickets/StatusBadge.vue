<script setup lang="ts">
import { computed } from "vue";
import { cn } from "@/lib/utils";
import { STATUS_BADGE_TONE } from "@/lib/statusColors";
import type { StatusCategory } from "@switchyard/shared";

const props = defineProps<{
  category: StatusCategory;
  displayName?: string;
  size?: "sm" | "md";
}>();

const tone = computed(() => STATUS_BADGE_TONE[props.category]);
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
