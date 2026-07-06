<script setup lang="ts">
// v4 live/agentic state tag (`.live-tag` in the design system): mono
// uppercase micro-label with a 6px status dot. `live` pulses coral (an agent
// is actively working); `warn` is static coral (needs attention, e.g. "plan
// ready" handled as live by callers); `stalled` is static blocked-red
// ("stalled 4d", "no LLM activity"). Board cards, dashboard cards, and the
// agent-run view all reuse this — build once, per the design handoff README.

import { computed } from "vue";
import { cn } from "@/lib/utils";

const props = defineProps<{
  tone?: "live" | "warn" | "stalled";
  class?: string;
}>();

const tone = computed(() => props.tone ?? "live");

const text = computed(() =>
  tone.value === "stalled" ? "text-st-blocked" : "text-signal-2",
);
const dot = computed(() =>
  tone.value === "stalled" ? "bg-st-blocked" : "bg-signal",
);
</script>

<template>
  <span
    :class="cn(
      'inline-flex items-center gap-1.5 font-mono text-[9.5px] font-medium uppercase tracking-[0.04em] whitespace-nowrap',
      text,
      props.class,
    )"
  >
    <span
      :class="cn('h-1.5 w-1.5 rounded-full', dot, tone === 'live' && 'animate-pulse')"
    />
    <slot />
  </span>
</template>
