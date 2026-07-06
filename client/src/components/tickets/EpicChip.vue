<script setup lang="ts">
import { computed } from "vue";

const props = defineProps<{ parent: { id: string; key: string; title: string } }>();

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
  <!-- v4: epics are uniformly planning-purple + mono (one family) instead
       of a per-epic hash hue. -->
  <span
    class="inline-flex max-w-[7rem] items-center rounded-[5px] border border-st-planning/30 bg-st-planning-bg px-1.5 h-5 font-mono text-[10px] font-medium text-st-planning whitespace-nowrap"
    :title="`${parent.key} — ${parent.title}`"
  >
    <span class="truncate">{{ shortLabel }}</span>
  </span>
</template>
