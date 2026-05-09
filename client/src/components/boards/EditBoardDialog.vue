<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/vue-query";
import { Loader2, Trash2 } from "lucide-vue-next";
import { toast } from "vue-sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { api } from "@/lib/api";
import { queryKeys } from "@/lib/queryKeys";
import type { Board } from "@switchyard/shared";

const props = defineProps<{ open: boolean; board: Board }>();
const emit = defineEmits<{ "update:open": [value: boolean] }>();

const router = useRouter();
const qc = useQueryClient();

const name = ref(props.board.name);
const selectedProjectIds = ref<Set<string>>(new Set(props.board.projects.map((p) => p.id)));
const confirmingDelete = ref(false);

watch(() => props.open, (v) => {
  if (v) {
    name.value = props.board.name;
    selectedProjectIds.value = new Set(props.board.projects.map((p) => p.id));
    confirmingDelete.value = false;
  }
});

const projectsQuery = useQuery({
  queryKey: queryKeys.projects(),
  staleTime: 5 * 60 * 1000,
  queryFn: async () => {
    const { data, error } = await api.GET("/v1/projects", { params: { query: { limit: 200 } } });
    if (error) throw error;
    return data;
  },
});
const projects = computed(() => projectsQuery.data.value?.items ?? []);

function toggle(id: string) {
  const next = new Set(selectedProjectIds.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  selectedProjectIds.value = next;
}

const canSave = computed(() =>
  name.value.trim().length > 0 && selectedProjectIds.value.size > 0
);

const saveMutation = useMutation({
  mutationFn: async () => {
    const { data, error } = await api.PATCH("/v1/boards/{id}", {
      params: { path: { id: props.board.id } },
      body: {
        name: name.value.trim(),
        project_ids: Array.from(selectedProjectIds.value),
      },
    });
    if (error) throw error;
    return data;
  },
  onSuccess: () => {
    qc.invalidateQueries({ queryKey: queryKeys.boards() });
    qc.invalidateQueries({ queryKey: queryKeys.board(props.board.id) });
    qc.invalidateQueries({ queryKey: queryKeys.boardColumns(props.board.id) });
    toast.success("Board updated");
    emit("update:open", false);
  },
});

const deleteMutation = useMutation({
  mutationFn: async () => {
    const { error } = await api.DELETE("/v1/boards/{id}", {
      params: { path: { id: props.board.id } },
    });
    if (error) throw error;
  },
  onSuccess: () => {
    qc.invalidateQueries({ queryKey: queryKeys.boards() });
    toast.success("Board deleted");
    emit("update:open", false);
    router.push("/boards");
  },
});
</script>

<template>
  <Dialog :open="open" @update:open="(v) => emit('update:open', v)">
    <DialogContent class="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>Edit board</DialogTitle>
        <DialogDescription>
          Rename the board or change which projects feed into it.
        </DialogDescription>
      </DialogHeader>

      <div class="space-y-4">
        <div class="space-y-1.5">
          <Label for="board-name-edit">Name</Label>
          <Input id="board-name-edit" v-model="name" />
        </div>

        <div class="space-y-1.5">
          <Label>Projects</Label>
          <div class="rounded-md border max-h-56 overflow-auto">
            <ul v-if="projectsQuery.isLoading.value" class="p-2 space-y-2">
              <li v-for="n in 4" :key="n">
                <Skeleton class="h-5 w-full" />
              </li>
            </ul>
            <ul v-else class="divide-y">
              <li
                v-for="p in projects"
                :key="p.id"
                class="flex items-center gap-2 px-3 py-2 text-sm hover:bg-accent/40 cursor-pointer"
                @click="toggle(p.id)"
              >
                <Checkbox
                  :model-value="selectedProjectIds.has(p.id)"
                  @click.stop="toggle(p.id)"
                />
                <span class="font-mono text-xs text-muted-foreground">{{ p.key }}</span>
                <span class="flex-1 truncate">{{ p.name }}</span>
              </li>
            </ul>
          </div>
        </div>
      </div>

      <DialogFooter class="gap-2 sm:gap-2 sm:justify-between">
        <Button
          v-if="!confirmingDelete"
          variant="ghost"
          size="sm"
          class="text-destructive hover:text-destructive hover:bg-destructive/10"
          @click="confirmingDelete = true"
        >
          <Trash2 class="h-3.5 w-3.5 mr-1" /> Delete
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
            class="h-3.5 w-3.5 mr-1 animate-spin"
          />
          Confirm delete
        </Button>

        <div class="flex gap-2">
          <Button variant="ghost" @click="emit('update:open', false)">Cancel</Button>
          <Button :disabled="!canSave || saveMutation.isPending.value" @click="saveMutation.mutate()">
            <Loader2
              v-if="saveMutation.isPending.value"
              class="h-3.5 w-3.5 mr-1.5 animate-spin"
            />
            Save
          </Button>
        </div>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
