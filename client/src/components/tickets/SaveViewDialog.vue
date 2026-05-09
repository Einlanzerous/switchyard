<script setup lang="ts">
// Tiny dialog for saving the currently-active filter combination as a
// named view. Surfaces the filters being captured so the user knows what
// they're committing to.

import { computed, ref, watch } from "vue";
import { Loader2 } from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "vue-sonner";
import { useTicketFilters } from "@/composables/useTicketFilters";
import { useCreateSavedView } from "@/composables/useSavedViews";
import type { SavedViewScope, SavedViewFilters } from "@switchyard/shared";

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ "update:open": [value: boolean] }>();

const { filters } = useTicketFilters();

const name = ref("");
const scope = ref<SavedViewScope>("personal");

watch(() => props.open, (v) => {
  if (!v) return;
  name.value = "";
  scope.value = "personal";
});

const previewItems = computed(() => {
  const f = filters.value;
  const out: string[] = [];
  if (f.project.length) out.push(`project=${f.project.join(",")}`);
  if (f.status.length) out.push(`status=${f.status.join(",")}`);
  if (f.type.length) out.push(`type=${f.type.join(",")}`);
  if (f.priority.length) out.push(`priority=${f.priority.join(",")}`);
  if (f.assignee) out.push(`assignee=${f.assignee}`);
  if (f.text) out.push(`text=${JSON.stringify(f.text)}`);
  return out;
});

const create = useCreateSavedView();

const canSubmit = computed(() => name.value.trim().length > 0);

async function submit() {
  if (!canSubmit.value) return;
  // Cast: SavedViewFilters is a strict version of our local TicketFilters
  // shape (assignee/text nullable instead of undefined).
  const body = {
    name: name.value.trim(),
    scope: scope.value,
    filters: {
      project: filters.value.project,
      status: filters.value.status,
      type: filters.value.type,
      priority: filters.value.priority,
      assignee: filters.value.assignee ?? null,
      text: filters.value.text ?? null,
    } satisfies SavedViewFilters,
  };
  try {
    await create.mutateAsync(body);
    toast.success(`Saved view "${body.name}"`);
    emit("update:open", false);
  } catch (e) {
    const msg = (e as { error?: { message?: string } })?.error?.message ?? "Failed to save view";
    toast.error(msg);
  }
}
</script>

<template>
  <Dialog :open="open" @update:open="(v) => emit('update:open', v)">
    <DialogContent class="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>Save view</DialogTitle>
        <DialogDescription>
          Name the current filter combination so you can re-apply it from the
          views menu or the command palette.
        </DialogDescription>
      </DialogHeader>

      <div class="space-y-3.5">
        <div class="space-y-1.5">
          <Label for="view-name">Name</Label>
          <Input id="view-name" v-model="name" placeholder="My queue" autofocus />
        </div>

        <div class="space-y-1.5">
          <Label>Scope</Label>
          <div class="grid grid-cols-2 gap-2">
            <button
              type="button"
              class="text-left rounded-md border px-3 py-2 text-sm transition-colors"
              :class="scope === 'personal'
                ? 'border-primary bg-accent/40'
                : 'border-border hover:bg-accent/40'"
              @click="scope = 'personal'"
            >
              <div class="font-medium">Personal</div>
              <div class="text-[11px] text-muted-foreground">Only you can see it.</div>
            </button>
            <button
              type="button"
              class="text-left rounded-md border px-3 py-2 text-sm transition-colors"
              :class="scope === 'shared'
                ? 'border-primary bg-accent/40'
                : 'border-border hover:bg-accent/40'"
              @click="scope = 'shared'"
            >
              <div class="font-medium">Shared</div>
              <div class="text-[11px] text-muted-foreground">Anyone in this workspace.</div>
            </button>
          </div>
        </div>

        <div class="space-y-1.5">
          <Label>Captured filters</Label>
          <div
            v-if="previewItems.length === 0"
            class="text-xs text-muted-foreground italic px-3 py-2 border rounded-md bg-muted/30"
          >
            No filters set. The view will show the unfiltered ticket list.
          </div>
          <ul v-else class="space-y-1 text-xs font-mono px-3 py-2 border rounded-md bg-muted/30 max-h-40 overflow-auto">
            <li v-for="item in previewItems" :key="item" class="truncate">{{ item }}</li>
          </ul>
        </div>
      </div>

      <DialogFooter>
        <Button variant="ghost" @click="emit('update:open', false)">Cancel</Button>
        <Button :disabled="!canSubmit || create.isPending.value" @click="submit">
          <Loader2 v-if="create.isPending.value" class="h-3.5 w-3.5 mr-1.5 animate-spin" />
          Save view
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
