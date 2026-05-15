<script setup lang="ts">
// Settings sub-tab of the project Setup page. Project metadata edit form
// (name / description / color / repo_url). Statuses + transitions are
// heavier UIs that still live under /settings/projects/:key/* — we link
// out from here rather than duplicating those views.

import { computed, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/vue-query";
import { Loader2, ExternalLink } from "lucide-vue-next";
import { toast } from "vue-sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import { queryKeys } from "@/lib/queryKeys";

const props = defineProps<{ projectKey: string }>();
const router = useRouter();
const qc = useQueryClient();

const projectQuery = useQuery({
  queryKey: computed(() => queryKeys.project(props.projectKey)),
  enabled: computed(() => props.projectKey.length > 0),
  queryFn: async () => {
    const { data, error } = await api.GET("/v1/projects/{key}", {
      params: { path: { key: props.projectKey } },
    });
    if (error) throw error;
    return data;
  },
});
const project = computed(() => projectQuery.data.value);

const name = ref("");
const description = ref("");
const color = ref("");
const repoUrl = ref("");

watch(project, (p) => {
  if (!p) return;
  name.value = p.name;
  description.value = p.description ?? "";
  color.value = p.color ?? "";
  repoUrl.value = p.repo_url ?? "";
}, { immediate: true });

const dirty = computed(() => {
  if (!project.value) return false;
  return name.value !== project.value.name
    || description.value !== (project.value.description ?? "")
    || (color.value || null) !== project.value.color
    || (repoUrl.value || null) !== project.value.repo_url;
});

const saveMutation = useMutation({
  mutationFn: async () => {
    const trimmedRepo = repoUrl.value.trim();
    const { data, error } = await api.PATCH("/v1/projects/{key}", {
      params: { path: { key: props.projectKey } },
      body: {
        name: name.value.trim(),
        description: description.value.trim() || undefined,
        color: color.value.trim() || undefined,
        repo_url: trimmedRepo === "" ? null : trimmedRepo,
      } as never,
    });
    if (error) throw error;
    return data;
  },
  onSuccess: () => {
    qc.invalidateQueries({ queryKey: queryKeys.project(props.projectKey) });
    qc.invalidateQueries({ queryKey: queryKeys.projects() });
    toast.success("Project updated");
  },
  onError: (err) => {
    toast.error((err as { error?: { message?: string } })?.error?.message ?? "Save failed");
  },
});

function goToStatuses() { router.push(`/settings/projects/${props.projectKey}/statuses`); }
function goToTransitions() { router.push(`/settings/projects/${props.projectKey}/transitions`); }
</script>

<template>
  <div class="px-4 py-4 space-y-4 max-w-2xl">
    <div v-if="projectQuery.isLoading.value" class="space-y-3">
      <Skeleton class="h-32 w-full" />
    </div>

    <template v-else-if="project">
      <Card>
        <CardHeader>
          <CardTitle class="text-base">Details</CardTitle>
          <CardDescription>The project key is immutable after creation.</CardDescription>
        </CardHeader>
        <CardContent class="space-y-3">
          <div class="space-y-1.5">
            <Label for="proj-key">Key</Label>
            <Input id="proj-key" :value="project.key" disabled class="font-mono w-32" />
          </div>
          <div class="space-y-1.5">
            <Label for="proj-name">Name</Label>
            <Input id="proj-name" v-model="name" />
          </div>
          <div class="space-y-1.5">
            <Label for="proj-desc">Description</Label>
            <textarea
              id="proj-desc"
              v-model="description"
              rows="3"
              class="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring resize-y"
            />
          </div>
          <div class="space-y-1.5">
            <Label for="proj-color">Color (#RRGGBB)</Label>
            <div class="flex items-center gap-2">
              <span
                class="inline-block h-7 w-7 rounded border"
                :style="color ? { backgroundColor: color } : undefined"
              />
              <Input id="proj-color" v-model="color" placeholder="#3b82f6" class="font-mono" />
            </div>
          </div>
          <div class="space-y-1.5">
            <Label for="proj-repo">Repo URL</Label>
            <Input
              id="proj-repo"
              v-model="repoUrl"
              type="url"
              placeholder="https://github.com/owner/repo"
              class="font-mono text-sm"
            />
            <p class="text-[11px] text-muted-foreground">
              When set, the project name in headers links here. Leave empty to keep the name as plain text.
            </p>
          </div>
          <div class="flex justify-end">
            <Button :disabled="!dirty || saveMutation.isPending.value" @click="saveMutation.mutate()">
              <Loader2 v-if="saveMutation.isPending.value" class="h-3.5 w-3.5 mr-1.5 animate-spin" />
              Save
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle class="text-base">Workflow</CardTitle>
          <CardDescription>
            Statuses and the transitions between them live in their own editors.
          </CardDescription>
        </CardHeader>
        <CardContent class="space-y-2">
          <Button variant="outline" class="w-full justify-between" @click="goToStatuses">
            <span>Statuses</span>
            <ExternalLink class="h-3.5 w-3.5" />
          </Button>
          <Button variant="outline" class="w-full justify-between" @click="goToTransitions">
            <span>Transitions</span>
            <ExternalLink class="h-3.5 w-3.5" />
          </Button>
        </CardContent>
      </Card>
    </template>
  </div>
</template>
