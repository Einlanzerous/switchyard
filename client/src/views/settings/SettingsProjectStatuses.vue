<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/vue-query";
import {
  ArrowLeft, Plus, Loader2, Trash2, Pencil, Check, ArrowUp, ArrowDown,
} from "lucide-vue-next";
import { toast } from "vue-sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import StatusBadge from "@/components/tickets/StatusBadge.vue";
import { api } from "@/lib/api";
import { queryKeys } from "@/lib/queryKeys";
import type { Status, StatusCategory } from "@switchyard/shared";

const route = useRoute();
const router = useRouter();
const qc = useQueryClient();

const projectKey = computed(() => {
  const v = route.params.key;
  return typeof v === "string" ? v : "";
});

const statusesQuery = useQuery({
  queryKey: computed(() => queryKeys.projectStatuses(projectKey.value)),
  enabled: computed(() => projectKey.value.length > 0),
  queryFn: async () => {
    const { data, error } = await api.GET("/v1/projects/{key}/statuses", {
      params: { path: { key: projectKey.value } },
    });
    if (error) throw error;
    return data;
  },
});

const statuses = computed<Status[]>(() => statusesQuery.data.value?.items ?? []);

// ─── create / edit dialog ───────────────────────────────────────────────────
const dialogOpen = ref(false);
const editing = ref<Status | null>(null);
const draftCategory = ref<StatusCategory>("backlog");
const draftDisplayName = ref("");
const draftIsDefault = ref(false);

const CATEGORIES: StatusCategory[] = ["backlog", "planning", "in_progress", "blocked", "closed"];

function openCreate() {
  editing.value = null;
  draftCategory.value = "backlog";
  draftDisplayName.value = "";
  draftIsDefault.value = false;
  dialogOpen.value = true;
}

function openEdit(s: Status) {
  editing.value = s;
  draftCategory.value = s.category;
  draftDisplayName.value = s.display_name;
  draftIsDefault.value = s.is_default;
  dialogOpen.value = true;
}

const saveMutation = useMutation({
  mutationFn: async () => {
    const body = {
      category: draftCategory.value,
      display_name: draftDisplayName.value.trim(),
      is_default: draftIsDefault.value,
    };
    if (editing.value) {
      const { data, error } = await api.PATCH("/v1/projects/{key}/statuses/{id}", {
        params: { path: { key: projectKey.value, id: editing.value.id } },
        body,
      });
      if (error) throw error;
      return data;
    }
    const { data, error } = await api.POST("/v1/projects/{key}/statuses", {
      params: { path: { key: projectKey.value } },
      body,
    });
    if (error) throw error;
    return data;
  },
  onSuccess: () => {
    qc.invalidateQueries({ queryKey: queryKeys.projectStatuses(projectKey.value) });
    qc.invalidateQueries({ queryKey: queryKeys.projectBoard(projectKey.value) });
    qc.invalidateQueries({ queryKey: ["sw", "boards"] });
    qc.invalidateQueries({ queryKey: ["sw", "tickets"] });
    toast.success(editing.value ? "Status updated" : "Status created");
    dialogOpen.value = false;
  },
});

const deletingId = ref<string | null>(null);
const deleteMutation = useMutation({
  mutationFn: async (id: string) => {
    deletingId.value = id;
    const { error } = await api.DELETE("/v1/projects/{key}/statuses/{id}", {
      params: { path: { key: projectKey.value, id } },
    });
    if (error) throw error;
  },
  onSuccess: () => {
    qc.invalidateQueries({ queryKey: queryKeys.projectStatuses(projectKey.value) });
    qc.invalidateQueries({ queryKey: queryKeys.projectBoard(projectKey.value) });
    toast.success("Status deleted");
  },
  onSettled: () => { deletingId.value = null; },
});

// ─── reorder via up/down buttons ────────────────────────────────────────────
// Drag-to-reorder would be polish; for the settings surface tap-up/tap-down
// arrows are unambiguous and accessible.
const reorderMutation = useMutation({
  mutationFn: async (orderedIds: string[]) => {
    const { data, error } = await api.POST("/v1/projects/{key}/statuses/reorder", {
      params: { path: { key: projectKey.value } },
      body: { status_ids: orderedIds },
    });
    if (error) throw error;
    return data;
  },
  onSuccess: () => {
    qc.invalidateQueries({ queryKey: queryKeys.projectStatuses(projectKey.value) });
    qc.invalidateQueries({ queryKey: queryKeys.projectBoard(projectKey.value) });
  },
});

function move(idx: number, delta: -1 | 1) {
  const arr = [...statuses.value];
  const target = idx + delta;
  if (target < 0 || target >= arr.length) return;
  [arr[idx], arr[target]] = [arr[target]!, arr[idx]!];
  reorderMutation.mutate(arr.map((s) => s.id));
}

// Keep dialog state in sync if the parent's editing target gets stale
// (e.g. invalidation refetched).
watch(statuses, (list) => {
  if (editing.value) {
    const fresh = list.find((s) => s.id === editing.value!.id);
    if (fresh) editing.value = fresh;
  }
});
</script>

<template>
  <div class="space-y-4">
    <Button
      variant="ghost"
      size="sm"
      class="-ml-2 text-muted-foreground"
      @click="router.push(`/settings/projects/${projectKey}`)"
    >
      <ArrowLeft class="h-3.5 w-3.5 mr-1" /> {{ projectKey }}
    </Button>

    <header class="flex items-end justify-between gap-3">
      <div>
        <h2 class="text-xl font-semibold tracking-tight">Statuses</h2>
        <p class="text-sm text-muted-foreground">
          The order here drives kanban column ordering. The default status is
          assigned to new tickets that don't specify one.
        </p>
      </div>
      <Button size="sm" @click="openCreate">
        <Plus class="h-3.5 w-3.5 mr-1.5" /> New status
      </Button>
    </header>

    <Card>
      <CardContent class="p-0">
        <div v-if="statusesQuery.isLoading.value" class="p-4 space-y-2">
          <Skeleton v-for="n in 5" :key="n" class="h-10 w-full" />
        </div>
        <ul v-else-if="statuses.length > 0" class="divide-y">
          <li
            v-for="(s, idx) in statuses"
            :key="s.id"
            class="flex items-center gap-3 p-3"
          >
            <div class="flex flex-col gap-0.5">
              <button
                type="button"
                class="rounded p-0.5 text-muted-foreground hover:bg-accent disabled:opacity-30"
                :disabled="idx === 0 || reorderMutation.isPending.value"
                @click="move(idx, -1)"
              >
                <ArrowUp class="h-3 w-3" />
              </button>
              <button
                type="button"
                class="rounded p-0.5 text-muted-foreground hover:bg-accent disabled:opacity-30"
                :disabled="idx === statuses.length - 1 || reorderMutation.isPending.value"
                @click="move(idx, 1)"
              >
                <ArrowDown class="h-3 w-3" />
              </button>
            </div>
            <StatusBadge :category="s.category" :display-name="s.display_name" />
            <Badge v-if="s.is_default" variant="secondary" class="text-[10px]">
              <Check class="h-2.5 w-2.5 mr-0.5" /> default
            </Badge>
            <span class="flex-1 text-xs text-muted-foreground">
              category: <span class="font-mono">{{ s.category }}</span>
            </span>
            <Button variant="ghost" size="sm" class="text-muted-foreground" @click="openEdit(s)">
              <Pencil class="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              class="text-muted-foreground hover:text-destructive"
              :disabled="deletingId === s.id"
              @click="deleteMutation.mutate(s.id)"
            >
              <Loader2 v-if="deletingId === s.id" class="h-3.5 w-3.5 animate-spin" />
              <Trash2 v-else class="h-3.5 w-3.5" />
            </Button>
          </li>
        </ul>
        <p v-else class="p-6 text-sm text-muted-foreground italic text-center">
          No statuses configured.
        </p>
      </CardContent>
    </Card>

    <Dialog v-model:open="dialogOpen">
      <DialogContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{{ editing ? "Edit status" : "New status" }}</DialogTitle>
          <DialogDescription>
            Pick a canonical category (drives kanban column placement) and a
            display name. Different projects can alias the same category — e.g.
            blocked → "On Hold".
          </DialogDescription>
        </DialogHeader>
        <div class="space-y-3">
          <div class="space-y-1.5">
            <Label>Category</Label>
            <Select v-model="draftCategory">
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem v-for="c in CATEGORIES" :key="c" :value="c" class="capitalize">
                  {{ c.replace("_", " ") }}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div class="space-y-1.5">
            <Label for="status-name">Display name</Label>
            <Input id="status-name" v-model="draftDisplayName" maxlength="50" />
          </div>
          <label class="flex items-center gap-2 text-sm cursor-pointer pt-1">
            <input type="checkbox" v-model="draftIsDefault" class="rounded" />
            Make this the default status for new tickets
          </label>
        </div>
        <DialogFooter>
          <Button variant="ghost" @click="dialogOpen = false">Cancel</Button>
          <Button
            :disabled="
              draftDisplayName.trim().length === 0 || saveMutation.isPending.value
            "
            @click="saveMutation.mutate()"
          >
            <Loader2 v-if="saveMutation.isPending.value" class="h-3.5 w-3.5 mr-1.5 animate-spin" />
            {{ editing ? "Save" : "Create" }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>
