<script setup lang="ts">
// Global LLM Insights (`/insights/llm`) — pipeline-wide across all visible
// projects. No project scope; the window selector in the header drives the body.

import { Zap } from "lucide-vue-next";
import LlmInsightsBody from "@/components/dashboard/LlmInsightsBody.vue";
import LlmWindowSelector from "@/components/dashboard/LlmWindowSelector.vue";
import { useLlmWindow } from "@/composables/useLlmWindow";

const { windowDays, range, bucket } = useLlmWindow();
</script>

<template>
  <div class="flex flex-col h-full">
    <div class="border-b bg-background/95 backdrop-blur sticky top-0 z-10">
      <div class="px-4 h-12 flex items-center gap-2">
        <Zap class="h-4 w-4 text-muted-foreground" />
        <h1 class="text-sm font-medium tracking-tight">LLM Insights</h1>
        <span class="text-[11px] text-muted-foreground">· all projects</span>
        <div class="flex-1 min-w-0" />
        <LlmWindowSelector v-model="windowDays" />
      </div>
    </div>

    <LlmInsightsBody :since="range.since" :until="range.until" :bucket="bucket" />
  </div>
</template>
