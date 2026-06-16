<script setup lang="ts">
// Segmented time-window control for the LLM Insights header. v-model is the
// selected number of days (1 / 3 / 7 / 30).

import { cn } from "@/lib/utils";
import { LLM_WINDOWS } from "@/composables/useLlmWindow";

const props = defineProps<{ modelValue: number }>();
const emit = defineEmits<{ "update:modelValue": [number] }>();
</script>

<template>
  <div class="inline-flex rounded-md border p-0.5 text-xs">
    <button
      v-for="w in LLM_WINDOWS"
      :key="w.d"
      type="button"
      :class="cn(
        'px-2.5 py-1 rounded transition-colors',
        props.modelValue === w.d
          ? 'bg-accent text-foreground font-medium'
          : 'text-muted-foreground hover:text-foreground',
      )"
      @click="emit('update:modelValue', w.d)"
    >{{ w.l }}</button>
  </div>
</template>
