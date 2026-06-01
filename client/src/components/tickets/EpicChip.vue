<script setup lang="ts">
import { computed } from "vue";
import { hueFromId } from "@/lib/colors";

const props = defineProps<{ parent: { id: string; key: string; title: string } }>();
const hue = computed(() => hueFromId(props.parent.id));
const shortLabel = computed(() => props.parent.title.trim().split(/\s+/).slice(0, 3).join(" "));
</script>

<template>
  <span
    class="inline-flex max-w-[7rem] items-center gap-1 rounded px-1.5 h-5 text-[10px] font-medium whitespace-nowrap"
    :style="{
      backgroundColor: `hsl(${hue} 55% 45% / 0.14)`,
      border: `1px solid hsl(${hue} 55% 45% / 0.45)`,
      color: `hsl(${hue} 50% 32%)`,
    }"
    :title="`${parent.key} — ${parent.title}`"
  >
    <span class="inline-block h-1.5 w-1.5 shrink-0 rounded-full" :style="{ backgroundColor: `hsl(${hue} 55% 45%)` }" />
    <span class="truncate">{{ shortLabel }}</span>
  </span>
</template>
