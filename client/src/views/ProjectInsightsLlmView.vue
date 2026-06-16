<script setup lang="ts">
// Per-project LLM Insights (`/projects/:key/insights/llm`). Tab sibling of the
// Board / Insights / Admin strip. Same shell as ProjectInsightsView so the tab
// swap leaves the chrome untouched; body is the shared LlmInsightsBody scoped
// to this project.

import { computed } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ArrowLeft, Plus } from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { useUiStore } from "@/stores/ui";
import InsightsTabs from "@/components/dashboard/InsightsTabs.vue";
import ProjectHeaderLabel from "@/components/projects/ProjectHeaderLabel.vue";
import LlmInsightsBody from "@/components/dashboard/LlmInsightsBody.vue";
import LlmWindowSelector from "@/components/dashboard/LlmWindowSelector.vue";
import { useLlmWindow } from "@/composables/useLlmWindow";

const route = useRoute();
const router = useRouter();
const ui = useUiStore();
const { windowDays, range, bucket } = useLlmWindow();

const projectKey = computed(() => {
  const v = route.params.key;
  return typeof v === "string" ? v : "";
});

function back() { router.push("/projects"); }
</script>

<template>
  <div class="flex flex-col h-full">
    <div class="border-b bg-background/95 backdrop-blur sticky top-0 z-10">
      <div class="px-4 h-12 flex items-center gap-2">
        <Button variant="ghost" size="sm" class="h-8 -ml-2" @click="back">
          <ArrowLeft class="h-3.5 w-3.5 mr-1" /> Back
        </Button>
        <Separator orientation="vertical" class="h-5" />
        <ProjectHeaderLabel :project-key="projectKey" :project="null" />
        <Separator orientation="vertical" class="h-5" />
        <InsightsTabs
          :board-path="`/projects/${projectKey}/board`"
          :insights-path="`/projects/${projectKey}/insights`"
          :llm-path="`/projects/${projectKey}/insights/llm`"
          :setup-path="`/projects/${projectKey}/setup`"
        />
        <div class="flex-1 min-w-0" />
        <LlmWindowSelector v-model="windowDays" />
        <Button size="sm" class="h-8" @click="ui.openCreateTicket(projectKey)">
          <Plus class="h-3.5 w-3.5 mr-1.5" /> New ticket
        </Button>
      </div>
    </div>

    <LlmInsightsBody
      :project="projectKey"
      :since="range.since"
      :until="range.until"
      :bucket="bucket"
    />
  </div>
</template>
