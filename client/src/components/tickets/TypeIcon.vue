<script setup lang="ts">
import { computed } from "vue";
import { Bug, CheckSquare2, Mountain, Lightbulb } from "lucide-vue-next";
import { cn } from "@/lib/utils";
import type { TicketType } from "@switchyard/shared";

const props = defineProps<{
  type: TicketType;
  class?: string;
}>();

const meta: Record<TicketType, { icon: any; tone: string; label: string }> = {
  spike: { icon: Lightbulb, tone: "text-purple-500", label: "Spike" },
  task: { icon: CheckSquare2, tone: "text-sky-500", label: "Task" },
  bug: { icon: Bug, tone: "text-red-500", label: "Bug" },
  epic: { icon: Mountain, tone: "text-amber-500", label: "Epic" },
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
