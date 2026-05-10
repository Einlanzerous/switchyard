<script setup lang="ts">
// Saved views dropdown for the tickets list header. Lists Personal first,
// then Shared. Click a view → applies its filters via the URL. The owner
// gets a small inline trash button on rows they own.

import { computed } from "vue";
import { Bookmark, Plus, Trash2, Users as UsersIcon, User as UserIcon } from "lucide-vue-next";
import { toast } from "vue-sonner";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useTicketFilters } from "@/composables/useTicketFilters";
import { useSavedViewsList, useDeleteSavedView } from "@/composables/useSavedViews";
import { useAuthStore } from "@/stores/auth";
import type { SavedView } from "@switchyard/shared";

const emit = defineEmits<{ save: [] }>();

const auth = useAuthStore();
const { replaceAll } = useTicketFilters();
const viewsQuery = useSavedViewsList();
const deleteMutation = useDeleteSavedView();

const views = computed<SavedView[]>(() => viewsQuery.data.value?.items ?? []);
const personal = computed(() =>
  views.value.filter((v) => v.scope === "personal" && v.owner.id === auth.me?.id)
);
const shared = computed(() => views.value.filter((v) => v.scope === "shared"));

function apply(view: SavedView) {
  replaceAll({
    project: view.filters.project ?? [],
    status: view.filters.status ?? [],
    type: view.filters.type ?? [],
    priority: view.filters.priority ?? [],
    assignee: view.filters.assignee ?? undefined,
    text: view.filters.text ?? undefined,
  });
}

async function remove(view: SavedView, e: MouseEvent) {
  e.stopPropagation();
  e.preventDefault();
  if (!confirm(`Delete view "${view.name}"?`)) return;
  try {
    await deleteMutation.mutateAsync(view.id);
    toast.success(`Deleted view "${view.name}"`);
  } catch (err) {
    const msg = (err as { error?: { message?: string } })?.error?.message ?? "Failed to delete";
    toast.error(msg);
  }
}

function isOwn(view: SavedView): boolean {
  return view.owner.id === auth.me?.id;
}
</script>

<template>
  <DropdownMenu>
    <DropdownMenuTrigger as-child>
      <Button variant="outline" size="sm" class="h-8">
        <Bookmark class="h-3.5 w-3.5 mr-1.5" /> Views
      </Button>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="end" class="w-64 max-h-[60vh] overflow-y-auto">
      <DropdownMenuLabel class="flex items-center justify-between">
        <span class="text-xs uppercase tracking-wider text-muted-foreground">Saved views</span>
      </DropdownMenuLabel>
      <DropdownMenuSeparator />

      <DropdownMenuItem class="cursor-pointer" @click="emit('save')">
        <Plus class="h-3.5 w-3.5 mr-2" /> Save current as view…
      </DropdownMenuItem>

      <template v-if="personal.length > 0">
        <DropdownMenuSeparator />
        <DropdownMenuLabel class="text-[10px] uppercase tracking-wider text-muted-foreground py-1">
          Personal
        </DropdownMenuLabel>
        <DropdownMenuItem
          v-for="v in personal"
          :key="v.id"
          class="cursor-pointer flex items-center gap-2"
          @click="apply(v)"
        >
          <UserIcon class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span class="flex-1 truncate">{{ v.name }}</span>
          <button
            class="rounded p-1 hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors"
            :aria-label="`Delete ${v.name}`"
            @click="(e) => remove(v, e)"
          >
            <Trash2 class="h-3 w-3" />
          </button>
        </DropdownMenuItem>
      </template>

      <template v-if="shared.length > 0">
        <DropdownMenuSeparator />
        <DropdownMenuLabel class="text-[10px] uppercase tracking-wider text-muted-foreground py-1">
          Shared
        </DropdownMenuLabel>
        <DropdownMenuItem
          v-for="v in shared"
          :key="v.id"
          class="cursor-pointer flex items-center gap-2"
          @click="apply(v)"
        >
          <UsersIcon class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span class="flex-1 truncate">{{ v.name }}</span>
          <span class="text-[10px] text-muted-foreground shrink-0">{{ v.owner.name }}</span>
          <button
            v-if="isOwn(v)"
            class="rounded p-1 hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors"
            :aria-label="`Delete ${v.name}`"
            @click="(e) => remove(v, e)"
          >
            <Trash2 class="h-3 w-3" />
          </button>
        </DropdownMenuItem>
      </template>

      <template v-if="personal.length === 0 && shared.length === 0">
        <DropdownMenuSeparator />
        <div class="px-2 py-2 text-xs text-muted-foreground italic">
          No saved views yet. Set up some filters and save them above.
        </div>
      </template>
    </DropdownMenuContent>
  </DropdownMenu>
</template>
