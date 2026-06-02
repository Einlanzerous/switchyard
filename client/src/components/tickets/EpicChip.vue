<script setup lang="ts">
import { computed } from "vue";
import { hueFromId } from "@/lib/colors";

const props = defineProps<{ parent: { id: string; key: string; title: string } }>();
const hue = computed(() => hueFromId(props.parent.id));

// Drop noisy leading markers like "Phase 6 — " or "New Login: " so the chip shows
// the meaningful epic name. Splits on a colon or a space-padded dash (—/–/--/-),
// so hyphenated names like "auto-login" stay intact. Greedy match strips to the
// last separator; falls back to the raw title if stripping leaves nothing.
const shortLabel = computed(() => {
  const title = props.parent.title.trim();
  const stripped = title.replace(/^.*(?::\s*|\s+(?:—|–|--|-)\s+)/, "").trim();
  return (stripped || title).split(/\s+/).slice(0, 3).join(" ");
});
</script>

<template>
  <span
    class="inline-flex max-w-[7rem] items-center rounded px-1.5 h-5 text-[10px] font-medium whitespace-nowrap"
    :style="{
      backgroundColor: `hsl(${hue} 55% 45% / 0.14)`,
      border: `1px solid hsl(${hue} 55% 45% / 0.45)`,
      color: `hsl(${hue} 50% 32%)`,
    }"
    :title="`${parent.key} — ${parent.title}`"
  >
    <span class="truncate">{{ shortLabel }}</span>
  </span>
</template>
