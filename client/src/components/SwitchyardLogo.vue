<script setup lang="ts">
import markUrl from "@/assets/sy_mark.svg";

// v4 brand lockup: a 34px "brand tile" (subtle gradient well holding the
// coral-plate mark) + a two-line uppercase text wordmark ("Switch / Yard").
// The mark SVG carries its own fills (coral plate #e2623d + off-white Y),
// so no dark:invert tricks are needed on the Elevated ink.
//
// The tile stays a fixed size/position while the wordmark slides in and out
// beside it (collapsed sidebar rail) — only the wordmark's clip box
// animates, so the mark never resizes mid-animation (SWY-129 behavior).
const props = defineProps<{ collapsed?: boolean }>();
</script>

<template>
  <div class="flex items-center gap-[11px] overflow-hidden">
    <!-- Brand tile — constant geometry, never animates. -->
    <div
      class="grid h-[34px] w-[34px] shrink-0 place-items-center rounded-[9px] border border-line bg-gradient-to-br from-[#17181c] to-[#0e0f12] shadow-[0_0_0_1px_rgba(0,0,0,0.4)]"
    >
      <img :src="markUrl" alt="Switchyard" class="h-[20px] w-auto" />
    </div>

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
