<script setup lang="ts">
import { computed } from "vue";
import { cn } from "@/lib/utils";

// Renders a horizontal 2px primary-tinted line above or below its parent
// card to show where a drop will land. The card uses `relative` positioning
// and we absolute-position to the relevant edge.
defineProps<{
  edge: "top" | "bottom";
}>();
</script>

<template>
  <div
    :class="cn(
      'pointer-events-none absolute left-0 right-0 h-[3px] rounded-full bg-primary z-10',
      edge === 'top' ? '-top-1' : '-bottom-1',
    )"
  >
    <!-- Small "dot" on the leading edge — Linear-style. Subtle, helps the eye
         catch the indicator on long columns. -->
    <span class="absolute left-0 -translate-x-1 top-1/2 -translate-y-1/2 h-2 w-2 rounded-full bg-primary" />
  </div>
</template>
