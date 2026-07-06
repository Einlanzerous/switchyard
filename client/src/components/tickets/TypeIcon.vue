<script setup lang="ts">
import { computed } from "vue";
import { Bug, CheckSquare2, Mountain, Lightbulb, ListTree } from "lucide-vue-next";
import { cn } from "@/lib/utils";
import type { TicketType } from "@switchyard/shared";

const props = defineProps<{
  type: TicketType;
  class?: string;
}>();

// v4 family hues: task progress-blue, epic + spike planning-purple (epic
// matches the epic chip), bug blocked-red, subtask agent steel.
const meta: Record<TicketType, { icon: any; tone: string; label: string }> = {
  spike: { icon: Lightbulb, tone: "text-st-planning", label: "Spike" },
  task: { icon: CheckSquare2, tone: "text-st-progress", label: "Task" },
  bug: { icon: Bug, tone: "text-st-blocked", label: "Bug" },
  epic: { icon: Mountain, tone: "text-st-planning", label: "Epic" },
  subtask: { icon: ListTree, tone: "text-agent", label: "Subtask" },
};

const data = computed(() => meta[props.type]);
</script>

<template>
  <component
    :is="data.icon"
    :class="cn('h-4 w-4 shrink-0', data.tone, props.class)"
    :aria-label="data.label"
    role="img"
  />
</template>
