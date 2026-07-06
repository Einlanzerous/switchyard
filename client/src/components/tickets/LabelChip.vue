<script setup lang="ts">
import type { LabelRef } from "@switchyard/shared";

defineProps<{
  label: LabelRef;
}>();
</script>

<template>
  <!-- v4 `.lbl` chip: quiet muted well; the 5px color dot carries the label
       hue instead of a tinted background. Uses theme slots (muted maps to
       surface-4 / ink-2 in dark) so light mode gets light chips too. -->
  <span
    class="inline-flex items-center gap-1.5 rounded-[5px] bg-muted px-1.5 h-5 text-[10.5px] font-medium text-muted-foreground whitespace-nowrap"
  >
    <span class="inline-block h-[5px] w-[5px] rounded-full" :style="{ backgroundColor: label.color }" />
    {{ label.name }}
  </span>
</template>
