<script setup lang="ts">
// Boxed segmented 7D / 12W / 1Y control for the Insights sub-header
// (SWY-149). v-model is the InsightsRangeKey from useInsightsRange.

import { cn } from "@/lib/utils";
import { INSIGHTS_RANGES, type InsightsRangeKey } from "@/composables/useInsightsRange";

const props = defineProps<{ modelValue: InsightsRangeKey }>();
const emit = defineEmits<{ "update:modelValue": [InsightsRangeKey] }>();
</script>

<template>
  <div class="inline-flex rounded-[8px] border border-line bg-surface-2 p-[2px]">
    <button
      v-for="r in INSIGHTS_RANGES"
      :key="r.key"
      type="button"
      :class="cn(
        'px-2.5 py-1 rounded-[6px] font-mono text-[11px] transition-colors',
        props.modelValue === r.key
          ? 'bg-surface-3 text-foreground'
          : 'text-ink-3 hover:text-foreground',
      )"
      @click="emit('update:modelValue', r.key)"
    >{{ r.label }}</button>
  </div>
</template>
