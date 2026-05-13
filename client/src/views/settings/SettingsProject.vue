<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { RouterLink, useRoute, useRouter } from "vue-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/vue-query";
import {
  ArrowLeft, Loader2, Trash2, Archive, ArchiveRestore, ChevronRight,
} from "lucide-vue-next";
import { toast } from "vue-sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import { queryKeys } from "@/lib/queryKeys";

const route = useRoute();
const router = useRouter();
const qc = useQueryClient();

const projectKey = computed(() => {
  const v = route.params.key;
  return typeof v === "string" ? v : "";
});

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

const project = computed(() => projectQuery.data.value);

const name = ref("");
const description = ref("");
const color = ref("");

watch(project, (p) => {
  if (!p) return;
  name.value = p.name;
  description.value = p.description ?? "";
  color.value = p.color ?? "";
}, { immediate: true });

const dirty = computed(() => {
  if (!project.value) return false;
  return name.value !== project.value.name
    || description.value !== (project.value.description ?? "")
    || (color.value || null) !== project.value.color;
});

const saveMutation = useMutation({
  mutationFn: async () => {
    const { data, error } = await api.PATCH("/v1/projects/{key}", {
      params: { path: { key: projectKey.value } },
      body: {
        name: name.value.trim(),
        description: description.value.trim() || undefined,
        color: color.value.trim() || undefined,
      },
    });
    if (error) throw error;
    return data;
  },
  onSuccess: () => {
    qc.invalidateQueries({ queryKey: queryKeys.project(projectKey.value) });
    qc.invalidateQueries({ queryKey: ["sw", "projects"] });
    toast.success("Project updated");
  },
});

// ─── board closed-window override ──────────────────────────────────────────

const systemSettingsQuery = useQuery({
  queryKey: queryKeys.systemSettings(),
  staleTime: 60 * 60 * 1000,
  queryFn: async () => {
    const { data, error } = await api.GET("/v1/settings", {});
    if (error) throw error;
    return data;
  },
});

const systemClosedWindow = computed<number>(() => {
  const v = systemSettingsQuery.data.value?.board_closed_window_days;
  return typeof v === "number" ? v : 14;
});

// "" = use system default; "7"/"14"/"30" = override.
const closedWindowValue = computed<string>({
  get: () => {
    const v = project.value?.board_closed_window_days;
    return typeof v === "number" ? String(v) : "";
  },
  set: () => { /* controlled by mutation below */ },
});

const closedWindowMutation = useMutation({
  mutationFn: async (raw: string) => {
    const next = raw === "" ? null : (Number(raw) as 7 | 14 | 30);
    const { error } = await api.PATCH("/v1/projects/{key}", {
      params: { path: { key: projectKey.value } },
      body: { board_closed_window_days: next as never },
    });
    if (error) throw error;
  },
  onSuccess: () => {
    qc.invalidateQueries({ queryKey: queryKeys.project(projectKey.value) });
    qc.invalidateQueries({ queryKey: ["sw", "projects"] });
    toast.success("Board override updated");
  },
});

const archiveMutation = useMutation({
  mutationFn: async () => {
    if (!project.value) return;
    const { data, error } = await api.PATCH("/v1/projects/{key}", {
      params: { path: { key: projectKey.value } },
      body: { archived: !project.value.archived_at },
    });
    if (error) throw error;
    return data;
  },
  onSuccess: () => {
    qc.invalidateQueries({ queryKey: queryKeys.project(projectKey.value) });
    qc.invalidateQueries({ queryKey: ["sw", "projects"] });
    toast.success(project.value?.archived_at ? "Project unarchived" : "Project archived");
  },
});

const confirmDelete = ref(false);
const deleteMutation = useMutation({
  mutationFn: async () => {
    const { error } = await api.DELETE("/v1/projects/{key}", {
      params: { path: { key: projectKey.value } },
    });
    if (error) throw error;
  },
  onSuccess: () => {
    qc.invalidateQueries({ queryKey: ["sw", "projects"] });
    toast.success(`Project ${projectKey.value} deleted`);
    router.push("/settings/projects");
  },
});
</script>

<template>
  <div class="space-y-4">
    <Button variant="ghost" size="sm" class="-ml-2 text-muted-foreground" @click="router.push('/settings/projects')">
      <ArrowLeft class="h-3.5 w-3.5 mr-1" /> Projects
    </Button>

    <div v-if="projectQuery.isLoading.value" class="space-y-3">
      <Skeleton class="h-7 w-48" />
      <Skeleton class="h-32 w-full" />
    </div>

    <template v-else-if="project">
      <header>
        <h2 class="text-xl font-semibold tracking-tight flex items-center gap-2">
          <span class="font-mono text-muted-foreground">{{ project.key }}</span>
          <span>{{ project.name }}</span>
        </h2>
        <p class="text-sm text-muted-foreground">
          Configure the project's metadata, statuses, and transitions.
        </p>
      </header>

      <!-- Sub-page links -->
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <RouterLink
          :to="`/settings/projects/${project.key}/statuses`"
          class="rounded-lg border bg-card p-4 hover:border-primary/50 hover:shadow-sm transition flex items-start gap-3"
        >
          <div class="flex-1">
            <h3 class="font-medium">Statuses</h3>
            <p class="text-xs text-muted-foreground">
              Reorder, rename, or change category. Mark a default for new tickets.
            </p>
          </div>
          <ChevronRight class="h-4 w-4 text-muted-foreground self-center" />
        </RouterLink>
        <RouterLink
          :to="`/settings/projects/${project.key}/transitions`"
          class="rounded-lg border bg-card p-4 hover:border-primary/50 hover:shadow-sm transition flex items-start gap-3"
        >
          <div class="flex-1">
            <h3 class="font-medium">Transitions</h3>
            <p class="text-xs text-muted-foreground">
              Define which status changes are allowed. Empty = anything goes.
            </p>
          </div>
          <ChevronRight class="h-4 w-4 text-muted-foreground self-center" />
        </RouterLink>
      </div>

      <Card>
        <CardHeader>
          <CardTitle class="text-base">Board</CardTitle>
          <CardDescription>
            How the Closed column on this project's kanban behaves. Leave on
            "system default" to inherit; override here when this project
            needs a different window than the rest of switchyard.
          </CardDescription>
        </CardHeader>
        <CardContent class="space-y-2">
          <div class="flex items-center gap-3">
            <Label for="proj-closed-window" class="shrink-0 w-44">Closed column window</Label>
            <select
              id="proj-closed-window"
              :value="closedWindowValue"
              class="rounded-md border bg-background px-2 py-1.5 text-sm"
              @change="(e) => closedWindowMutation.mutate((e.target as HTMLSelectElement).value)"
            >
              <option value="">System default ({{ systemClosedWindow }}d)</option>
              <option value="7">7 days</option>
              <option value="14">14 days</option>
              <option value="30">30 days</option>
            </select>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle class="text-base">Details</CardTitle>
          <CardDescription>The project key is immutable after creation.</CardDescription>
        </CardHeader>
        <CardContent class="space-y-3">
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
          <div class="flex justify-end">
            <Button :disabled="!dirty || saveMutation.isPending.value" @click="saveMutation.mutate()">
              <Loader2 v-if="saveMutation.isPending.value" class="h-3.5 w-3.5 mr-1.5 animate-spin" />
              Save
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card class="border-destructive/40">
        <CardHeader>
          <CardTitle class="text-base text-destructive">Danger zone</CardTitle>
          <CardDescription>
            Archived projects are hidden from default lists but their tickets remain.
            Deleting is soft (recoverable from the database) but invisible from the UI.
          </CardDescription>
        </CardHeader>
        <CardContent class="space-y-2">
          <div class="flex items-center justify-between">
            <span class="text-sm">
              {{ project.archived_at ? "Currently archived" : "Currently active" }}
            </span>
            <Button
              variant="outline"
              size="sm"
              :disabled="archiveMutation.isPending.value"
              @click="archiveMutation.mutate()"
            >
              <Loader2
                v-if="archiveMutation.isPending.value"
                class="h-3.5 w-3.5 mr-1.5 animate-spin"
              />
              <component
                :is="project.archived_at ? ArchiveRestore : Archive"
                class="h-3.5 w-3.5 mr-1.5"
              />
              {{ project.archived_at ? "Unarchive" : "Archive" }}
            </Button>
          </div>
          <div class="flex items-center justify-between pt-2 border-t">
            <span class="text-sm">Soft-delete this project</span>
            <Button
              v-if="!confirmDelete"
              variant="outline"
              size="sm"
              class="text-destructive hover:bg-destructive/10"
              @click="confirmDelete = true"
            >
              <Trash2 class="h-3.5 w-3.5 mr-1.5" /> Delete
            </Button>
            <Button
              v-else
              variant="destructive"
              size="sm"
              :disabled="deleteMutation.isPending.value"
              @click="deleteMutation.mutate()"
            >
              <Loader2
                v-if="deleteMutation.isPending.value"
                class="h-3.5 w-3.5 mr-1.5 animate-spin"
              />
              Confirm delete
            </Button>
          </div>
        </CardContent>
      </Card>
    </template>
  </div>
</template>
