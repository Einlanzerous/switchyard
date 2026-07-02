<script setup lang="ts">
import markUrl from "@/assets/sy_mark.svg";
import wordmarkUrl from "@/assets/sy_wordmark.svg";

// The logo is composed of two separate crops of the same source SVG so the
// cube mark can stay a fixed size/position while the wordmark slides in and
// out beside it (collapsed sidebar rail). Swapping a single combined <img>
// resized the whole mark mid-animation; keeping them separate means only the
// wordmark's width animates. Both keep `dark:invert` for light/dark theming.
const props = defineProps<{ collapsed?: boolean }>();
</script>

<template>
  <div class="flex items-center overflow-hidden">
    <!-- Cube mark — constant geometry, never animates. -->
    <img :src="markUrl" alt="Switchyard" class="h-[48px] w-auto shrink-0 dark:invert" />

    <!-- Wordmark — the clip box animates its max-width (horizontal reveal)
         while the inner image eases + fades so it reads as sliding into the
         mark. max-w-[68px] ≈ the wordmark's rendered width at h-48 (a few px of
         slack, so the full reveal animates without clipping the trailing 'd'). -->
    <div
      class="overflow-hidden transition-[max-width,opacity] duration-200 ease-in-out"
      :class="props.collapsed ? 'max-w-0 opacity-0' : 'max-w-[68px] opacity-100'"
    >
      <img
        :src="wordmarkUrl"
        alt=""
        aria-hidden="true"
        class="h-[48px] w-auto max-w-none pl-1 dark:invert transition-transform duration-200 ease-in-out"
        :class="props.collapsed ? '-translate-x-2' : 'translate-x-0'"
      />
    </div>
  </div>
</template>
