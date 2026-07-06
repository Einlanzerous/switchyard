<script setup lang="ts">
// v4 `.agent-tag` pill: mono uppercase steel micro-badge marking machine
// actors ("agent") in leaderboards, plan review, and run views. Slot
// overrides the label (e.g. a model name).
</script>

<template>
  <span
    class="inline-flex h-[19px] items-center rounded-[5px] border border-agent/25 bg-agent-bg px-1.5 font-mono text-[10px] font-medium uppercase tracking-[0.04em] text-agent whitespace-nowrap"
  >
    <slot>agent</slot>
  </span>
</template>
