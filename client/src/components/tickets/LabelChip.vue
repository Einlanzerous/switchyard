<script setup lang="ts">
import type { LabelRef } from "@switchyard/shared";

defineProps<{
  label: LabelRef;
}>();
</script>

<template>
  <!-- v4 `.lbl` chip: quiet surface-4 well; the 5px color dot carries the
       label hue instead of a tinted background. -->
  <span
    class="inline-flex items-center gap-1.5 rounded-[5px] bg-surface-4 px-1.5 h-5 text-[10.5px] font-medium text-ink-2 whitespace-nowrap"
  >
    <span class="inline-block h-[5px] w-[5px] rounded-full" :style="{ backgroundColor: label.color }" />
    {{ label.name }}
  </span>
</template>
