<script setup lang="ts">
import { computed } from "vue";
import { cn } from "@/lib/utils";
import { ChevronDown, Equal, ChevronUp, Flame } from "lucide-vue-next";
import type { Priority } from "@switchyard/shared";

const props = defineProps<{
  priority: Priority | null | undefined;
  showLabel?: boolean;
}>();

// v4: high reads in the coral signal (per the ticket full-page mock's meta
// row); medium in progress-blue, critical in blocked-red.
const meta: Record<Priority, { tone: string; icon: any; label: string }> = {
  low: { tone: "text-muted-foreground", icon: ChevronDown, label: "Low" },
  medium: { tone: "text-st-progress", icon: Equal, label: "Medium" },
  high: { tone: "text-signal-2", icon: ChevronUp, label: "High" },
  critical: { tone: "text-st-blocked", icon: Flame, label: "Critical" },
};

const data = computed(() => (props.priority ? meta[props.priority] : null));
</script>

<template>
  <span
    v-if="data"
    :class="cn('inline-flex items-center gap-1 text-xs whitespace-nowrap', data.tone)"
    :title="data.label"
  >
    <component :is="data.icon" class="h-3.5 w-3.5" />
    <span v-if="showLabel">{{ data.label }}</span>
  </span>
  <span v-else class="inline-flex h-3.5 w-3.5 text-muted-foreground/40">—</span>
</template>
