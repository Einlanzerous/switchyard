<script setup lang="ts">
import markUrl from "@/assets/sy_mark.svg";

// v4 brand lockup, per the handoff mocks' `.brand-mark`: the raw coral-plate
// mark at 42×44 (the plate baked into the SVG IS the tile — no extra well
// around it) + a two-line uppercase text wordmark ("Switch / Yard"). The SVG
// carries its own fills, so no dark:invert tricks are needed.
//
// The mark stays a fixed size/position while the wordmark slides in and out
// beside it (collapsed sidebar rail) — only the wordmark's clip box
// animates, so the mark never resizes mid-animation (SWY-129 behavior).
const props = defineProps<{ collapsed?: boolean }>();
</script>

<template>
  <div class="flex items-center gap-[11px] overflow-hidden">
    <!-- Mark — constant geometry, never animates. -->
    <img
      :src="markUrl"
      alt="Switchyard"
      class="h-[44px] w-[42px] shrink-0"
    />

    <!-- Wordmark — the clip box animates its max-width (horizontal reveal)
         while the inner block eases + fades so it reads as sliding into the
         mark. max-w-[76px] ≈ the wordmark's rendered width plus slack so the
         full reveal animates without clipping. -->
    <div
      class="overflow-hidden transition-[max-width,opacity] duration-200 ease-in-out"
      :class="props.collapsed ? 'max-w-0 opacity-0' : 'max-w-[76px] opacity-100'"
    >
      <div
        aria-hidden="true"
        class="whitespace-nowrap font-bold uppercase leading-[1.08] tracking-[0.14em] text-foreground text-[12.5px] transition-transform duration-200 ease-in-out"
        :class="props.collapsed ? '-translate-x-2' : 'translate-x-0'"
      >
        <span class="block">Switch</span>
        <span class="block">Yard</span>
      </div>
    </div>
  </div>
</template>
