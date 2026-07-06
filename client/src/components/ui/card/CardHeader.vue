<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import { cn } from "@/lib/utils"

const props = defineProps<{
  class?: HTMLAttributes["class"]
}>()
</script>

<template>
  <!-- v4 density: card headers sit at 14/16 padding (was p-6). -->
  <div :class="cn('flex flex-col gap-y-1 px-4 py-3.5', props.class)">
    <slot />
  </div>
</template>
