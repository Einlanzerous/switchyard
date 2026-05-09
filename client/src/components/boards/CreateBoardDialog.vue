<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/vue-query";
import { Loader2 } from "lucide-vue-next";
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

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ "update:open": [value: boolean] }>();

const router = useRouter();
const qc = useQueryClient();

const name = ref("");
const selectedProjectIds = ref<Set<string>>(new Set());

watch(() => props.open, (v) => {
  if (v) {
    name.value = "";
    selectedProjectIds.value = new Set();
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

const canSubmit = computed(() =>
  name.value.trim().length > 0 && selectedProjectIds.value.size > 0
);

const createMutation = useMutation({
  mutationFn: async () => {
    const { data, error } = await api.POST("/v1/boards", {
      body: {
        name: name.value.trim(),
        layout: "kanban",
        project_ids: Array.from(selectedProjectIds.value),
      },
    });
    if (error) throw error;
    return data;
  },
  onSuccess: (board) => {
    qc.invalidateQueries({ queryKey: queryKeys.boards() });
    toast.success(`Board "${name.value.trim()}" created`);
    emit("update:open", false);
    if (board?.id) router.push(`/boards/${board.id}`);
  },
});
</script>

<template>
  <Dialog :open="open" @update:open="(v) => emit('update:open', v)">
    <DialogContent class="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>New board</DialogTitle>
        <DialogDescription>
          A board groups tickets across one or more projects into a single kanban view.
        </DialogDescription>
      </DialogHeader>

      <div class="space-y-4">
        <div class="space-y-1.5">
          <Label for="board-name">Name</Label>
          <Input
            id="board-name"
            v-model="name"
            placeholder="e.g. Active work"
            autofocus
          />
        </div>

        <div class="space-y-1.5">
          <Label>Projects</Label>
          <p class="text-xs text-muted-foreground">
            Pick at least one. Tickets from all selected projects appear on the board.
          </p>
          <div class="rounded-md border max-h-56 overflow-auto">
            <ul v-if="projectsQuery.isLoading.value" class="p-2 space-y-2">
              <li v-for="n in 4" :key="n">
                <Skeleton class="h-5 w-full" />
              </li>
            </ul>
            <ul v-else-if="projects.length > 0" class="divide-y">
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
            <p v-else class="p-3 text-sm text-muted-foreground italic">No projects yet.</p>
          </div>
        </div>
      </div>

      <DialogFooter>
        <Button variant="ghost" @click="emit('update:open', false)">Cancel</Button>
        <Button
          :disabled="!canSubmit || createMutation.isPending.value"
          @click="createMutation.mutate()"
        >
          <Loader2 v-if="createMutation.isPending.value" class="h-3.5 w-3.5 mr-1.5 animate-spin" />
          Create board
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
