<script setup lang="ts">
// Compact tab-strip used as the header for /projects/:key Board / Insights
// and /boards/:id Board / Insights pairs. Vue-router-driven so the active
// tab reflects the URL.

import { useRoute, useRouter } from "vue-router";
import { computed } from "vue";
import { KanbanSquare, BarChart2, Repeat } from "lucide-vue-next";
import { cn } from "@/lib/utils";

const props = defineProps<{
  boardPath: string;
  insightsPath: string;
  // Optional: when set, renders a third "Recurring" tab. Project-scoped
  // views pass this; board-scoped views don't (no recurring templates at
  // the board level — they're project-bound).
  recurringPath?: string;
}>();

const route = useRoute();
const router = useRouter();

const tabs = computed(() => {
  const base = [
    { key: "board", label: "Board", icon: KanbanSquare, path: props.boardPath },
    { key: "insights", label: "Insights", icon: BarChart2, path: props.insightsPath },
  ];
  if (props.recurringPath) {
    base.push({ key: "recurring", label: "Recurring", icon: Repeat, path: props.recurringPath });
  }
  return base;
});

function isActive(p: string): boolean {
  return route.path === p;
}
</script>

<template>
  <nav class="flex items-center gap-0.5 -mb-px">
    <button
      v-for="t in tabs"
      :key="t.key"
      type="button"
      :class="cn(
        'inline-flex items-center gap-1.5 px-3 h-8 text-sm border-b-2 -mb-[2px] transition-colors',
        isActive(t.path)
          ? 'border-primary text-foreground font-medium'
          : 'border-transparent text-muted-foreground hover:text-foreground'
      )"
      @click="router.push(t.path)"
    >
      <component :is="t.icon" class="h-3.5 w-3.5" />
      {{ t.label }}
    </button>
  </nav>
</template>
