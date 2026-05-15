<script setup lang="ts">
// Project key + name label used in the header of every project view
// (Board / Insights / Setup). When the project has a `repo_url`, the
// name becomes a link to the repo. Key stays inert (font-mono identifier).

import { ExternalLink } from "lucide-vue-next";
import type { ProjectRef } from "@switchyard/shared";

defineProps<{
  projectKey: string | null;
  project: Pick<ProjectRef, "name" | "repo_url"> | null;
}>();
</script>

<template>
  <span v-if="projectKey" class="font-mono text-sm text-muted-foreground">{{ projectKey }}</span>
  <span v-if="project?.name" class="text-muted-foreground/40">—</span>
  <a
    v-if="project?.name && project.repo_url"
    :href="project.repo_url"
    target="_blank"
    rel="noopener noreferrer"
    class="text-sm font-medium truncate inline-flex items-center gap-1 hover:underline hover:text-foreground transition-colors"
    :title="project.repo_url"
  >
    {{ project.name }}
    <ExternalLink class="h-3 w-3 opacity-60 shrink-0" />
  </a>
  <span v-else-if="project?.name" class="text-sm font-medium truncate">
    {{ project.name }}
  </span>
</template>
