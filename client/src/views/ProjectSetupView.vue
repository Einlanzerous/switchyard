<script setup lang="ts">
// Project Setup tab — three sub-tabs (Recurring / Automations / Settings).
// The outer chrome (Back / project label / InsightsTabs / New ticket)
// matches the Board and Insights views. Sub-tabs live below in a
// secondary nav row; the sub-view renders via <router-view>.

import { computed } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useQuery } from "@tanstack/vue-query";
import { ArrowLeft, Plus, Repeat, Zap, Users, Settings as SettingsIcon } from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { useUiStore } from "@/stores/ui";
import { useAuthStore } from "@/stores/auth";
import { useProjectStats } from "@/composables/useProjectStats";
import InsightsTabs from "@/components/dashboard/InsightsTabs.vue";
import ProjectHeaderLabel from "@/components/projects/ProjectHeaderLabel.vue";
import { api } from "@/lib/api";
import { queryKeys } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";

const route = useRoute();
const router = useRouter();
const ui = useUiStore();
const auth = useAuthStore();

const projectKey = computed(() => {
  const v = route.params.key;
  return typeof v === "string" ? v : "";
});

const stats = useProjectStats(computed(() => projectKey.value || null));

// Fetch the project detail for the caller's `my_role` — gates the Members tab.
const projectQuery = useQuery({
  queryKey: computed(() => queryKeys.project(projectKey.value)),
  enabled: computed(() => projectKey.value.length > 0),
  queryFn: async () => {
    const { data, error } = await api.GET("/v1/projects/{key}", {
      params: { path: { key: projectKey.value } },
    });
    if (error) throw error;
    return data;
  },
});
// Membership management is project-admin (+ instance owner) only.
const canManageMembers = computed(
  () => auth.isOwner || projectQuery.data.value?.my_role === "admin",
);

const subTabs = computed(() => [
  { key: "recurring",   label: "Recurring",   icon: Repeat,       path: `/projects/${projectKey.value}/setup/recurring` },
  { key: "automations", label: "Automations", icon: Zap,          path: `/projects/${projectKey.value}/setup/automations` },
  ...(canManageMembers.value
    ? [{ key: "members", label: "Members", icon: Users, path: `/projects/${projectKey.value}/setup/members` }]
    : []),
  { key: "settings",    label: "Settings",    icon: SettingsIcon, path: `/projects/${projectKey.value}/setup/settings` },
]);

function isActiveSubTab(p: string): boolean {
  return route.path === p || route.path.startsWith(p + "/");
}

function back() { router.push("/projects"); }
</script>

<template>
  <div class="flex flex-col h-full">
    <!-- Top header — matches Board/Insights -->
    <div class="border-b bg-background/95 backdrop-blur sticky top-0 z-10">
      <div class="px-4 h-12 flex items-center gap-2">
        <Button variant="ghost" size="sm" class="h-8 -ml-2" @click="back">
          <ArrowLeft class="h-3.5 w-3.5 mr-1" /> Back
        </Button>
        <Separator orientation="vertical" class="h-5" />
        <ProjectHeaderLabel :project-key="projectKey" :project="stats.data.value?.project ?? null" />
        <Separator orientation="vertical" class="h-5" />
        <InsightsTabs
          :board-path="`/projects/${projectKey}/board`"
          :insights-path="`/projects/${projectKey}/insights`"
          :setup-path="`/projects/${projectKey}/setup`"
        />
        <div class="flex-1 min-w-0" />
        <Button size="sm" class="h-8" @click="ui.openCreateTicket(projectKey)">
          <Plus class="h-3.5 w-3.5 mr-1.5" /> New ticket
        </Button>
      </div>

      <!-- Sub-tab nav row -->
      <div class="px-4 flex items-center gap-1 -mb-px">
        <button
          v-for="t in subTabs"
          :key="t.key"
          type="button"
          :class="cn(
            'inline-flex items-center gap-1.5 px-3 h-9 text-sm border-b-2 -mb-[2px] transition-colors',
            isActiveSubTab(t.path)
              ? 'border-primary text-foreground font-medium'
              : 'border-transparent text-muted-foreground hover:text-foreground'
          )"
          @click="router.push(t.path)"
        >
          <component :is="t.icon" class="h-3.5 w-3.5" />
          {{ t.label }}
        </button>
      </div>
    </div>

    <!-- Body -->
    <div class="flex-1 overflow-auto">
      <!-- @vue-expect-error router-view passes extra attrs through as props to the matched route component, which RouterViewProps doesn't model -->
      <router-view :project-key="projectKey" />
    </div>
  </div>
</template>
