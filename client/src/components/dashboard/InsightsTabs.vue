<script setup lang="ts">
// Compact tab-strip used as the header for /projects/:key Board / Insights
// and /boards/:id Board / Insights pairs. Vue-router-driven so the active
// tab reflects the URL.

import { useRoute, useRouter } from "vue-router";
import { computed } from "vue";
import { KanbanSquare, BarChart2, Zap, Settings as SettingsIcon } from "lucide-vue-next";
import { cn } from "@/lib/utils";

const props = defineProps<{
  boardPath: string;
  insightsPath: string;
  // Optional: when set, renders an "LLM" tab for the per-project LLM Insights
  // view (SWY-48). Sits between Insights and Admin.
  llmPath?: string;
  // Optional: when set, renders a third "Admin" tab containing the
  // project's recurring templates, project-scoped automations, and
  // project settings as sub-tabs. Project-scoped views pass this;
  // board-scoped views don't (those concerns are project-bound).
  setupPath?: string;
}>();

const route = useRoute();
const router = useRouter();

const tabs = computed(() => {
  const base = [
    { key: "board", label: "Board", icon: KanbanSquare, path: props.boardPath },
    { key: "insights", label: "Insights", icon: BarChart2, path: props.insightsPath },
  ];
  if (props.llmPath) {
    base.push({ key: "llm", label: "LLM", icon: Zap, path: props.llmPath });
  }
  if (props.setupPath) {
    base.push({ key: "setup", label: "Admin", icon: SettingsIcon, path: props.setupPath });
  }
  return base;
});

function isActive(p: string): boolean {
  // The Setup tab has sub-routes (/setup/recurring, /setup/automations,
  // etc.). Match any sub-path so the tab stays highlighted as the user
  // moves between sub-tabs.
  if (props.setupPath && p === props.setupPath) {
    return route.path === p || route.path.startsWith(p + "/");
  }
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
