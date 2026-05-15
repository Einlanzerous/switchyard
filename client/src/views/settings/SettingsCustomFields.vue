<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useMutation, useQuery, useQueryClient } from "@tanstack/vue-query";
import {
  Plus, Loader2, Trash2, Pencil, Database, Globe, FolderKanban,
} from "lucide-vue-next";
import { toast } from "vue-sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import EmptyState from "@/components/EmptyState.vue";
import { api } from "@/lib/api";
import { queryKeys } from "@/lib/queryKeys";
import type { CustomField, CustomFieldType, Project } from "@switchyard/shared";

const qc = useQueryClient();

const fieldsQuery = useQuery({
  queryKey: queryKeys.customFields(),
  queryFn: async () => {
    const { data, error } = await api.GET("/v1/custom-fields", {});
    if (error) throw error;
    return data;
  },
});

const projectsQuery = useQuery({
  queryKey: queryKeys.projects(),
  queryFn: async () => {
    const { data, error } = await api.GET("/v1/projects", { params: { query: { limit: 200 } } });
    if (error) throw error;
    return data;
  },
});

const items = computed<CustomField[]>(() => fieldsQuery.data.value?.items ?? []);
// `board_closed_window_days` is typed as `7 | 14 | 30 | unknown` by the
// generated client (zod-to-openapi emits the nullable as `{ nullable: true }`
// which openapi-typescript reads as `unknown`). The runtime shape is correct;
// cast through `unknown` so the rest of the file sees the proper Project type.
const projects = computed<Project[]>(
  () => (projectsQuery.data.value?.items ?? []) as unknown as Project[],
);

// Bucket fields into "global" vs "per-project". Project rows are
// grouped under their project; we render each group as its own section.
const globalFields = computed(() => items.value.filter((f) => f.project_id === null));
const projectFields = computed(() => {
  const grouped = new Map<string, CustomField[]>();
  for (const f of items.value) {
    if (f.project_id === null) continue;
    const arr = grouped.get(f.project_id) ?? [];
    arr.push(f);
    grouped.set(f.project_id, arr);
  }
  return [...grouped.entries()].map(([pid, fields]) => ({
    project: projects.value.find((p) => p.id === pid) ?? null,
    pid,
    fields: fields.sort((a, b) => a.key.localeCompare(b.key)),
  }));
});

// ─── create/edit dialog ─────────────────────────────────────────────────────
const dialogOpen = ref(false);
const editing = ref<CustomField | null>(null);

const draftProjectId = ref<string>(""); // "" = global
const draftKey = ref("");
const draftLabel = ref("");
const draftType = ref<CustomFieldType>("text");
const draftOptionsText = ref(""); // newline-separated for select
const draftShowOnCard = ref(false);
const draftShowOnCreate = ref(false);
const draftShowOnFilter = ref(false);

const TYPES: CustomFieldType[] = ["text", "number", "boolean", "url", "select"];

watch(dialogOpen, (v) => {
  if (!v) editing.value = null;
});

function openCreate() {
  editing.value = null;
  draftProjectId.value = "";
  draftKey.value = "";
  draftLabel.value = "";
  draftType.value = "text";
  draftOptionsText.value = "";
  draftShowOnCard.value = false;
  draftShowOnCreate.value = false;
  draftShowOnFilter.value = false;
  dialogOpen.value = true;
}

function openEdit(f: CustomField) {
  editing.value = f;
  draftProjectId.value = f.project_id ?? "";
  draftKey.value = f.key;
  draftLabel.value = f.label;
  draftType.value = f.type;
  draftOptionsText.value = (f.options?.values ?? []).join("\n");
  draftShowOnCard.value = f.show_on_card;
  draftShowOnCreate.value = f.show_on_create_form;
  draftShowOnFilter.value = f.show_on_filter_bar;
  dialogOpen.value = true;
}

function parseOptions(): { values: string[] } | undefined {
  const lines = draftOptionsText.value
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return undefined;
  return { values: lines };
}

const canSave = computed(() => {
  if (draftKey.value.trim().length === 0) return false;
  if (!/^[a-z][a-z0-9_]*$/.test(draftKey.value.trim())) return false;
  if (draftLabel.value.trim().length === 0) return false;
  if (draftType.value === "select" && parseOptions() === undefined) return false;
  return true;
});

const saveMutation = useMutation({
  mutationFn: async () => {
    const options = draftType.value === "select" ? parseOptions() : undefined;
    if (editing.value) {
      const body: Record<string, unknown> = {
        label: draftLabel.value.trim(),
        show_on_card: draftShowOnCard.value,
        show_on_create_form: draftShowOnCreate.value,
        show_on_filter_bar: draftShowOnFilter.value,
      };
      if (editing.value.type === "select") body.options = options ?? null;
      const { error } = await api.PATCH("/v1/custom-fields/{id}", {
        params: { path: { id: editing.value.id } },
        body: body as never,
      });
      if (error) throw error;
      return { kind: "updated" as const };
    }
    const body: Record<string, unknown> = {
      project_id: draftProjectId.value || null,
      key: draftKey.value.trim(),
      label: draftLabel.value.trim(),
      type: draftType.value,
      show_on_card: draftShowOnCard.value,
      show_on_create_form: draftShowOnCreate.value,
      show_on_filter_bar: draftShowOnFilter.value,
    };
    if (draftType.value === "select") body.options = options;
    const { error } = await api.POST("/v1/custom-fields", { body: body as never });
    if (error) throw error;
    return { kind: "created" as const };
  },
  onSuccess: (r) => {
    qc.invalidateQueries({ queryKey: queryKeys.customFields() });
    toast.success(r.kind === "created" ? "Custom field created" : "Custom field updated");
    dialogOpen.value = false;
  },
  onError: (err: unknown) => {
    const msg = (err as { error?: { message?: string } })?.error?.message ?? "Save failed";
    toast.error(msg);
  },
});

const deletingId = ref<string | null>(null);
const deleteMutation = useMutation({
  mutationFn: async (id: string) => {
    deletingId.value = id;
    const { error } = await api.DELETE("/v1/custom-fields/{id}", { params: { path: { id } } });
    if (error) throw error;
  },
  onSuccess: () => {
    qc.invalidateQueries({ queryKey: queryKeys.customFields() });
    toast.success("Custom field deleted (existing metadata data preserved)");
  },
  onSettled: () => { deletingId.value = null; },
});

function visibilitySummary(f: CustomField): string {
  const parts: string[] = [];
  if (f.show_on_card) parts.push("card");
  if (f.show_on_create_form) parts.push("create-form");
  if (f.show_on_filter_bar) parts.push("filter-bar");
  return parts.length > 0 ? parts.join(", ") : "(hidden)";
}
</script>

<template>
  <div class="space-y-4">
    <header class="flex items-end justify-between gap-3">
      <div>
        <h2 class="text-xl font-semibold tracking-tight">Custom fields</h2>
        <p class="text-sm text-muted-foreground">
          Typed views over <code class="text-xs">metadata.&lt;key&gt;</code> on tickets. Storage
          stays in the metadata JSONB — declaring a field doesn't migrate
          existing data, and deleting one doesn't drop any.
        </p>
      </div>
      <Button size="sm" @click="openCreate">
        <Plus class="h-3.5 w-3.5 mr-1.5" /> New field
      </Button>
    </header>

    <!-- Global fields -->
    <Card>
      <CardContent class="p-0">
        <header class="flex items-center gap-2 p-3 border-b">
          <Globe class="h-3.5 w-3.5 text-muted-foreground" />
          <h3 class="text-sm font-medium">Global</h3>
          <span class="text-xs text-muted-foreground">apply to every project</span>
        </header>
        <div v-if="fieldsQuery.isLoading.value" class="p-4 space-y-2">
          <Skeleton v-for="n in 2" :key="n" class="h-12 w-full" />
        </div>
        <ul v-else-if="globalFields.length > 0" class="divide-y">
          <li v-for="f in globalFields" :key="f.id" class="flex items-start gap-3 p-3">
            <Database class="h-4 w-4 text-muted-foreground shrink-0 mt-1" />
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-2 flex-wrap">
                <span class="font-mono text-sm">{{ f.key }}</span>
                <Badge variant="secondary" class="text-[10px]">{{ f.type }}</Badge>
                <span class="text-sm text-muted-foreground">{{ f.label }}</span>
              </div>
              <div class="text-xs text-muted-foreground mt-0.5">
                visibility: {{ visibilitySummary(f) }}
                <template v-if="f.type === 'select' && f.options">
                  · options: {{ f.options.values.join(", ") }}
                </template>
              </div>
            </div>
            <Button variant="ghost" size="sm" @click="openEdit(f)">
              <Pencil class="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              class="text-muted-foreground hover:text-destructive"
              :disabled="deletingId === f.id"
              @click="deleteMutation.mutate(f.id)"
            >
              <Loader2 v-if="deletingId === f.id" class="h-3.5 w-3.5 animate-spin" />
              <Trash2 v-else class="h-3.5 w-3.5" />
            </Button>
          </li>
        </ul>
        <EmptyState
          v-else
          :icon="Globe"
          title="No global fields"
          description="A global field applies to every project. Useful for cross-cutting state like repo_url, pr_url, or branch_name."
          size="sm"
        />
      </CardContent>
    </Card>

    <!-- Per-project fields (one card per project) -->
    <Card v-for="bucket in projectFields" :key="bucket.pid">
      <CardContent class="p-0">
        <header class="flex items-center gap-2 p-3 border-b">
          <FolderKanban class="h-3.5 w-3.5 text-muted-foreground" />
          <h3 class="text-sm font-medium font-mono">{{ bucket.project?.key ?? bucket.pid }}</h3>
          <span class="text-xs text-muted-foreground">{{ bucket.project?.name ?? "" }}</span>
        </header>
        <ul class="divide-y">
          <li v-for="f in bucket.fields" :key="f.id" class="flex items-start gap-3 p-3">
            <Database class="h-4 w-4 text-muted-foreground shrink-0 mt-1" />
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-2 flex-wrap">
                <span class="font-mono text-sm">{{ f.key }}</span>
                <Badge variant="secondary" class="text-[10px]">{{ f.type }}</Badge>
                <span class="text-sm text-muted-foreground">{{ f.label }}</span>
              </div>
              <div class="text-xs text-muted-foreground mt-0.5">
                visibility: {{ visibilitySummary(f) }}
                <template v-if="f.type === 'select' && f.options">
                  · options: {{ f.options.values.join(", ") }}
                </template>
              </div>
            </div>
            <Button variant="ghost" size="sm" @click="openEdit(f)">
              <Pencil class="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              class="text-muted-foreground hover:text-destructive"
              :disabled="deletingId === f.id"
              @click="deleteMutation.mutate(f.id)"
            >
              <Loader2 v-if="deletingId === f.id" class="h-3.5 w-3.5 animate-spin" />
              <Trash2 v-else class="h-3.5 w-3.5" />
            </Button>
          </li>
        </ul>
      </CardContent>
    </Card>

    <!-- Create/edit dialog -->
    <Dialog v-model:open="dialogOpen">
      <DialogContent class="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{{ editing ? "Edit custom field" : "New custom field" }}</DialogTitle>
          <DialogDescription>
            <template v-if="editing">
              Key, project, and type are immutable after creation.
              Renaming would silently break tickets carrying the old shape.
            </template>
            <template v-else>
              Declare a typed view over <code class="text-xs">metadata.&lt;key&gt;</code>.
              Pick a project for scoped fields, leave global for cross-project state.
            </template>
          </DialogDescription>
        </DialogHeader>
        <div class="space-y-3">
          <div class="grid grid-cols-2 gap-3">
            <div class="space-y-1.5">
              <Label for="cf-scope">Scope</Label>
              <select
                id="cf-scope"
                v-model="draftProjectId"
                :disabled="!!editing"
                class="w-full rounded-md border bg-background px-2 py-1.5 text-sm"
              >
                <option value="">Global</option>
                <option v-for="p in projects" :key="p.id" :value="p.id">{{ p.key }} — {{ p.name }}</option>
              </select>
            </div>
            <div class="space-y-1.5">
              <Label for="cf-type">Type</Label>
              <select
                id="cf-type"
                v-model="draftType"
                :disabled="!!editing"
                class="w-full rounded-md border bg-background px-2 py-1.5 text-sm"
              >
                <option v-for="t in TYPES" :key="t" :value="t">{{ t }}</option>
              </select>
            </div>
          </div>

          <div class="space-y-1.5">
            <Label for="cf-key">Key</Label>
            <Input
              id="cf-key"
              v-model="draftKey"
              :disabled="!!editing"
              placeholder="repo_url"
              class="font-mono text-sm"
            />
            <p class="text-xs text-muted-foreground">
              Lowercase identifier matching <code>metadata.&lt;key&gt;</code>. Letters,
              digits, underscores. Must start with a letter.
            </p>
          </div>

          <div class="space-y-1.5">
            <Label for="cf-label">Label</Label>
            <Input
              id="cf-label"
              v-model="draftLabel"
              placeholder="Repo URL"
              autofocus
            />
          </div>

          <div v-if="draftType === 'select'" class="space-y-1.5">
            <Label for="cf-options">Options (one per line)</Label>
            <textarea
              id="cf-options"
              v-model="draftOptionsText"
              rows="4"
              class="w-full rounded-md border bg-background px-3 py-2 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-ring resize-y"
              placeholder="modify&#10;scaffold&#10;greenfield"
            />
            <p class="text-xs text-muted-foreground">
              The pipeline code is the source of truth for these values; keep
              this list in lockstep to avoid drift.
            </p>
          </div>

          <div class="space-y-2 pt-1">
            <Label class="text-xs text-muted-foreground uppercase tracking-wider">Visibility</Label>
            <div class="space-y-1.5">
              <label class="flex items-center gap-2 text-sm cursor-pointer">
                <Checkbox v-model="draftShowOnCard" />
                Show on ticket cards
              </label>
              <label class="flex items-center gap-2 text-sm cursor-pointer">
                <Checkbox v-model="draftShowOnCreate" />
                Show on the create-ticket form
              </label>
              <label class="flex items-center gap-2 text-sm cursor-pointer">
                <Checkbox v-model="draftShowOnFilter" />
                Show on the filter bar
              </label>
            </div>
            <p class="text-xs text-muted-foreground">
              All three unset = machine-only (still queryable via API + DSL).
            </p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" @click="dialogOpen = false">Cancel</Button>
          <Button
            :disabled="!canSave || saveMutation.isPending.value"
            @click="saveMutation.mutate()"
          >
            <Loader2 v-if="saveMutation.isPending.value" class="h-3.5 w-3.5 mr-1.5 animate-spin" />
            {{ editing ? "Save" : "Create field" }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>
