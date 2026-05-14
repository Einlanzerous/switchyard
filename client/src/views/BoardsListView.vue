<script setup lang="ts">
import { computed, ref } from "vue";
import { Plus, KanbanSquare, AlertCircle, Trash2 } from "lucide-vue-next";
import { useMutation, useQueryClient } from "@tanstack/vue-query";
import { toast } from "vue-sonner";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import CreateBoardDialog from "@/components/boards/CreateBoardDialog.vue";
import { useBoardsList } from "@/composables/useBoards";
import { api } from "@/lib/api";
import { queryKeys } from "@/lib/queryKeys";
import { formatDistanceToNow } from "date-fns";

const boards = useBoardsList();
const items = computed(() => boards.data.value?.items ?? []);
const showCreate = ref(false);
const qc = useQueryClient();

const errMessage = computed(() => {
  const e = boards.error.value;
  if (!e) return null;
  return (e as { error?: { message?: string } }).error?.message ?? "Failed to load boards";
});

function relative(iso: string): string {
  try { return formatDistanceToNow(new Date(iso), { addSuffix: true }); }
  catch { return ""; }
}

// A board with zero projects has nothing to render — surface a one-click
// cleanup so empty boards don't accumulate as dead navigation entries.
// Inline two-step confirm matches the EditBoardDialog / SettingsProject
// pattern (no shadcn AlertDialog component in the project).
const confirmingId = ref<string | null>(null);
const deletingId = ref<string | null>(null);
const deleteMutation = useMutation({
  mutationFn: async (id: string) => {
    const { error } = await api.DELETE("/v1/boards/{id}", { params: { path: { id } } });
    if (error) throw error;
  },
  onSuccess: () => {
    qc.invalidateQueries({ queryKey: queryKeys.boards() });
    toast.success("Board deleted");
  },
  onError: (err) => {
    const msg = (err as { error?: { message?: string } }).error?.message ?? "Delete failed";
    toast.error(msg);
  },
  onSettled: () => {
    deletingId.value = null;
    confirmingId.value = null;
  },
});

function startConfirm(id: string) { confirmingId.value = id; }
function cancelConfirm() { confirmingId.value = null; }
function doDelete(id: string) {
  deletingId.value = id;
  deleteMutation.mutate(id);
}
</script>

<template>
  <div class="container max-w-5xl py-8 space-y-6">
    <header>
      <h1 class="text-2xl font-semibold tracking-tight">Boards</h1>
      <p class="text-sm text-muted-foreground mt-1">
        Saved kanban views across one or more projects.
      </p>
    </header>

    <div v-if="boards.isLoading.value" class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
      <Skeleton v-for="n in 3" :key="n" class="h-36" />
    </div>

    <div v-else-if="errMessage" class="text-sm text-destructive flex items-center gap-2">
      <AlertCircle class="h-4 w-4" /> {{ errMessage }}
    </div>

    <div v-else class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
      <RouterLink
        v-for="b in items"
        :key="b.id"
        :to="`/boards/${b.id}`"
        class="group"
      >
        <Card class="h-full hover:border-primary/60 hover:shadow-md transition-all">
          <CardHeader>
            <CardTitle class="text-base flex items-center gap-2">
              <KanbanSquare class="h-4 w-4 text-muted-foreground" />
              <span class="truncate">{{ b.name }}</span>
              <span
                v-if="b.auto_include_all_projects"
                class="text-[10px] uppercase tracking-wider rounded-full bg-indigo-500/15 text-indigo-600 dark:text-indigo-400 px-2 py-0.5 font-bold"
                title="Auto-managed: switchyard adds every new project and prunes archived ones. Editing projects manually opts this board out."
              >Auto</span>
            </CardTitle>
            <CardDescription class="text-xs">
              {{ b.projects.length }} project{{ b.projects.length === 1 ? "" : "s" }}
              · updated {{ relative(b.updated_at) }}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div v-if="b.projects.length === 0" class="flex items-center justify-between gap-2">
              <span class="text-[11px] text-muted-foreground">
                No projects — nothing to show.
              </span>
              <div v-if="confirmingId !== b.id" class="flex items-center">
                <Button
                  variant="ghost"
                  size="sm"
                  class="h-7 px-2 text-destructive hover:bg-destructive/10 hover:text-destructive"
                  :disabled="deletingId === b.id"
                  @click.stop.prevent="startConfirm(b.id)"
                >
                  <Trash2 class="h-3.5 w-3.5 mr-1" />
                  Delete
                </Button>
              </div>
              <div v-else class="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  class="h-7 px-2"
                  :disabled="deletingId === b.id"
                  @click.stop.prevent="cancelConfirm"
                >
                  Cancel
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  class="h-7 px-2"
                  :disabled="deletingId === b.id"
                  @click.stop.prevent="doDelete(b.id)"
                >
                  {{ deletingId === b.id ? "Deleting…" : "Confirm delete" }}
                </Button>
              </div>
            </div>
            <div v-else class="flex flex-wrap gap-1">
              <span
                v-for="p in b.projects.slice(0, 6)"
                :key="p.id"
                class="inline-flex items-center rounded border bg-muted/40 px-1.5 h-5 text-[10px] font-mono"
                :style="p.color ? { borderColor: p.color + '55' } : undefined"
              >
                {{ p.key }}
              </span>
              <span
                v-if="b.projects.length > 6"
                class="text-[10px] text-muted-foreground self-center"
              >
                +{{ b.projects.length - 6 }} more
              </span>
            </div>
          </CardContent>
        </Card>
      </RouterLink>

      <!-- Dotted "New board" tile that fills its grid slot. When there are no
           boards yet, it spans all columns and acts as the empty-state CTA. -->
      <button
        type="button"
        class="rounded-lg border-2 border-dashed border-border bg-card/30 hover:bg-accent/30 hover:border-primary/50 transition-colors flex flex-col items-center justify-center text-center text-muted-foreground py-10 px-4 min-h-[10rem]"
        :class="items.length === 0 && 'sm:col-span-2 lg:col-span-3'"
        @click="showCreate = true"
      >
        <Plus class="h-5 w-5 mb-1.5" />
        <span class="text-sm font-medium">New board</span>
        <span v-if="items.length === 0" class="text-xs mt-1">
          Group one or more projects into a single kanban view.
        </span>
      </button>
    </div>

    <CreateBoardDialog v-model:open="showCreate" />
  </div>
</template>
