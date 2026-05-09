<script setup lang="ts">
import type { LabelRef } from "@switchyard/shared";

defineProps<{
  label: LabelRef;
}>();
</script>

<template>
  <span
    class="inline-flex items-center gap-1 rounded-md border px-1.5 h-5 text-[10px] font-medium text-foreground/80 whitespace-nowrap"
    :style="{ backgroundColor: `${label.color}1f`, borderColor: `${label.color}55` }"
  >
    <span class="inline-block h-1.5 w-1.5 rounded-full" :style="{ backgroundColor: label.color }" />
    {{ label.name }}
  </span>
</template>
