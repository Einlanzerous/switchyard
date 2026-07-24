<script setup lang="ts">
import { computed } from "vue";

const props = defineProps<{ parent: { id: string; key: string; title: string } }>();

// Show the epic's leading name — the segment before the FIRST separator: a
// space-padded dash (—/–/--/-) or a colon followed by space. Intra-word hyphens
// and apostrophes ("Auto-run", "won't") are preserved because they aren't
// spaced, so only true separators split. So "Scale Hardening — fixes for the…"
// → "Scale Hardening" and "Phase 6 — Authz" → "Phase 6". The full "KEY — title"
// stays in the chip tooltip; the chip itself CSS-truncates. A dedicated,
// author-set epic label (instead of deriving from the title) is tracked in
// SWY-170.
const shortLabel = computed(() => {
  const title = props.parent.title.trim();
  const head = title.split(/\s+(?:—|–|--|-)\s+|:\s+/)[0]!.trim();
  return head || title;
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
