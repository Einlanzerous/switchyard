<script setup lang="ts">
import { computed, ref } from "vue";
import { useMutation, useQuery, useQueryClient } from "@tanstack/vue-query";
import { Plus, Loader2, Trash2, Pencil } from "lucide-vue-next";
import { toast } from "vue-sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import LabelChip from "@/components/tickets/LabelChip.vue";
import { api } from "@/lib/api";
import { queryKeys } from "@/lib/queryKeys";
import type { Label as LabelType } from "@switchyard/shared";

const qc = useQueryClient();

const labelsQuery = useQuery({
  queryKey: queryKeys.labels(),
  queryFn: async () => {
    const { data, error } = await api.GET("/v1/labels");
    if (error) throw error;
    return data;
  },
});

const items = computed(() => labelsQuery.data.value?.items ?? []);

// ─── create/edit dialog (reused) ─────────────────────────────────────────
const editing = ref<LabelType | null>(null);
const dialogOpen = ref(false);
const draftName = ref("");
const draftColor = ref("#3b82f6");

// A small palette covering the common ticket-tag use cases. Users can still
// type any 6-digit hex into the input to override.
const SWATCHES = [
  "#ef4444", "#f97316", "#f59e0b", "#eab308", "#84cc16", "#22c55e",
  "#10b981", "#14b8a6", "#06b6d4", "#0ea5e9", "#3b82f6", "#6366f1",
  "#8b5cf6", "#a855f7", "#d946ef", "#ec4899", "#f43f5e", "#64748b",
];

function openCreate() {
  editing.value = null;
  draftName.value = "";
  draftColor.value = SWATCHES[Math.floor(Math.random() * SWATCHES.length)]!;
  dialogOpen.value = true;
}

function openEdit(lbl: LabelType) {
  editing.value = lbl;
  draftName.value = lbl.name;
  draftColor.value = lbl.color;
  dialogOpen.value = true;
}

const previewLabel = computed<LabelType | null>(() => {
  if (!draftName.value.trim()) return null;
  return {
    id: editing.value?.id ?? "preview",
    name: draftName.value,
    color: draftColor.value,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
});

const saveMutation = useMutation({
  mutationFn: async () => {
    const body = { name: draftName.value.trim(), color: draftColor.value };
    if (editing.value) {
      const { data, error } = await api.PATCH("/v1/labels/{id}", {
        params: { path: { id: editing.value.id } },
        body,
      });
      if (error) throw error;
      return data;
    }
    const { data, error } = await api.POST("/v1/labels", { body });
    if (error) throw error;
    return data;
  },
  onSuccess: () => {
    qc.invalidateQueries({ queryKey: queryKeys.labels() });
    qc.invalidateQueries({ queryKey: ["sw", "tickets"] });
    qc.invalidateQueries({ queryKey: ["sw", "ticket"] });
    qc.invalidateQueries({ queryKey: ["sw", "boards"] });
    toast.success(editing.value ? "Label updated" : "Label created");
    dialogOpen.value = false;
  },
});

const deletingId = ref<string | null>(null);
const deleteMutation = useMutation({
  mutationFn: async (id: string) => {
    deletingId.value = id;
    const { error } = await api.DELETE("/v1/labels/{id}", { params: { path: { id } } });
    if (error) throw error;
  },
  onSuccess: () => {
    qc.invalidateQueries({ queryKey: queryKeys.labels() });
    qc.invalidateQueries({ queryKey: ["sw", "tickets"] });
    qc.invalidateQueries({ queryKey: ["sw", "ticket"] });
    toast.success("Label deleted");
  },
  onSettled: () => { deletingId.value = null; },
});

const validHex = computed(() => /^#[0-9a-fA-F]{6}$/.test(draftColor.value));
const canSave = computed(() => draftName.value.trim().length > 0 && validHex.value);
</script>

<template>
  <div class="space-y-4">
    <header class="flex items-end justify-between gap-3">
      <div>
        <h2 class="text-xl font-semibold tracking-tight">Labels</h2>
        <p class="text-sm text-muted-foreground">
          Global label catalog — these apply to tickets in any project.
        </p>
      </div>
      <Button size="sm" @click="openCreate">
        <Plus class="h-3.5 w-3.5 mr-1.5" /> New label
      </Button>
    </header>

    <Card>
      <CardContent class="p-0">
        <div v-if="labelsQuery.isLoading.value" class="p-4 space-y-2">
          <Skeleton v-for="n in 4" :key="n" class="h-9 w-full" />
        </div>
        <ul v-else-if="items.length > 0" class="divide-y">
          <li v-for="lbl in items" :key="lbl.id" class="flex items-center gap-3 p-3">
            <LabelChip :label="lbl" />
            <div class="flex-1 font-mono text-xs text-muted-foreground">{{ lbl.color }}</div>
            <Button variant="ghost" size="sm" class="text-muted-foreground" @click="openEdit(lbl)">
              <Pencil class="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              class="text-muted-foreground hover:text-destructive"
              :disabled="deletingId === lbl.id"
              @click="deleteMutation.mutate(lbl.id)"
            >
              <Loader2 v-if="deletingId === lbl.id" class="h-3.5 w-3.5 animate-spin" />
              <Trash2 v-else class="h-3.5 w-3.5" />
            </Button>
          </li>
        </ul>
        <p v-else class="p-6 text-sm text-muted-foreground text-center italic">
          No labels yet — use "New label" to add the first one.
        </p>
      </CardContent>
    </Card>

    <Dialog v-model:open="dialogOpen">
      <DialogContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{{ editing ? "Edit label" : "New label" }}</DialogTitle>
          <DialogDescription>
            Labels are global. Use a short name + a distinct color.
          </DialogDescription>
        </DialogHeader>

        <div class="space-y-3">
          <div class="space-y-1.5">
            <Label for="lbl-name">Name</Label>
            <Input id="lbl-name" v-model="draftName" maxlength="50" autofocus />
          </div>

          <div class="space-y-1.5">
            <Label>Color</Label>
            <div class="flex flex-wrap gap-1.5">
              <button
                v-for="c in SWATCHES"
                :key="c"
                type="button"
                class="h-7 w-7 rounded-md border-2 transition"
                :class="draftColor === c ? 'border-foreground' : 'border-transparent'"
                :style="{ backgroundColor: c }"
                :title="c"
                @click="draftColor = c"
              />
            </div>
            <Input
              v-model="draftColor"
              class="font-mono text-xs"
              placeholder="#3b82f6"
              maxlength="7"
            />
            <p
              v-if="draftColor && !validHex"
              class="text-xs text-destructive"
            >Color must be a 6-digit hex like #3b82f6.</p>
          </div>

          <div v-if="previewLabel" class="pt-2 border-t flex items-center gap-2">
            <span class="text-xs text-muted-foreground">Preview:</span>
            <LabelChip :label="previewLabel" />
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" @click="dialogOpen = false">Cancel</Button>
          <Button :disabled="!canSave || saveMutation.isPending.value" @click="saveMutation.mutate()">
            <Loader2 v-if="saveMutation.isPending.value" class="h-3.5 w-3.5 mr-1.5 animate-spin" />
            {{ editing ? "Save" : "Create label" }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>
