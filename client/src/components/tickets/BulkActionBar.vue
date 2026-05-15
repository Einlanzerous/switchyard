<script setup lang="ts">
// Bulk-action bar for the tickets list. Sticky floating bar in the bottom
// right when ≥ 1 row is selected. Actions fan out per-ticket against
// existing endpoints (PATCH/DELETE/POST :transition); a dedicated bulk
// endpoint will land if N* round-trip latency ever bites.
//
// Cross-project safe by default. Bulk transition opens a separate modal
// (BulkTransitionModal) that does the per-project status mapping.

import { computed, ref } from "vue";
import { useQuery, useQueryClient } from "@tanstack/vue-query";
import {
  X, UserPlus, Tag, MoveRight, Trash2, Loader2, Check,
} from "lucide-vue-next";
import { toast } from "vue-sonner";
import { Button } from "@/components/ui/button";
import {
  Popover, PopoverContent, PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList,
} from "@/components/ui/command";
import { api } from "@/lib/api";
import { queryKeys } from "@/lib/queryKeys";
import type { TicketSummary, UserRef, LabelRef } from "@switchyard/shared";
import BulkTransitionModal from "./BulkTransitionModal.vue";

const props = defineProps<{
  // Map of ticket key → ticket summary, restricted to currently-selected
  // rows. We pass the full summaries (not just keys) so label/assignee
  // operations can read the ticket's current state without re-fetching.
  selectedTickets: TicketSummary[];
}>();

const emit = defineEmits<{ clear: [] }>();

const qc = useQueryClient();

const count = computed(() => props.selectedTickets.length);
const visible = computed(() => count.value > 0);

const projects = computed(() => {
  // Distinct project keys in the selection. Used for the transition modal
  // and to decide whether to enable the bulk-status action (always enabled
  // — the modal handles cross-project mapping).
  const set = new Set<string>();
  for (const t of props.selectedTickets) set.add(t.project.key);
  return Array.from(set);
});

// ─── data sources ──────────────────────────────────────────────────────────

const usersQuery = useQuery({
  queryKey: queryKeys.users(),
  staleTime: 5 * 60 * 1000,
  queryFn: async () => {
    const { data, error } = await api.GET("/v1/users", { params: { query: { limit: 200 } } });
    if (error) throw error;
    return data;
  },
});
const users = computed<UserRef[]>(() => usersQuery.data.value?.items ?? []);

const labelsQuery = useQuery({
  queryKey: queryKeys.labels(),
  staleTime: 5 * 60 * 1000,
  queryFn: async () => {
    const { data, error } = await api.GET("/v1/labels");
    if (error) throw error;
    return data;
  },
});
const labels = computed<LabelRef[]>(() => labelsQuery.data.value?.items ?? []);

// Labels that appear on AT LEAST ONE selected ticket — these are the ones
// we offer in the "Remove label" menu so we don't show options that won't
// do anything.
const labelsOnSelection = computed<LabelRef[]>(() => {
  const seen = new Set<string>();
  const out: LabelRef[] = [];
  for (const t of props.selectedTickets) {
    for (const lbl of t.labels) {
      if (seen.has(lbl.id)) continue;
      seen.add(lbl.id);
      out.push(lbl);
    }
  }
  return out;
});

// ─── ui state ──────────────────────────────────────────────────────────────

const assignOpen = ref(false);
const addLabelOpen = ref(false);
const removeLabelOpen = ref(false);
const transitionOpen = ref(false);
const busy = ref(false);
const confirmDelete = ref(false);

// ─── actions ───────────────────────────────────────────────────────────────

function invalidateAfterMutation() {
  // Broad invalidation — the bulk action could've touched any project / board
  // / ticket / event surface. Cheaper than enumerating every cache key.
  qc.invalidateQueries({ queryKey: ["sw", "tickets"] });
  qc.invalidateQueries({ queryKey: ["sw", "projects"] });
  qc.invalidateQueries({ queryKey: ["sw", "boards"] });
  qc.invalidateQueries({ queryKey: ["sw", "events"] });
  qc.invalidateQueries({ queryKey: ["sw", "stats"] });
}

async function withBusy<T>(label: string, run: () => Promise<T>): Promise<T | null> {
  busy.value = true;
  try {
    const result = await run();
    invalidateAfterMutation();
    emit("clear");
    return result;
  } catch (e) {
    const msg = (e as { error?: { message?: string } })?.error?.message ?? `Bulk ${label} failed`;
    toast.error(msg);
    return null;
  } finally {
    busy.value = false;
  }
}

async function bulkAssign(userId: string | null) {
  assignOpen.value = false;
  await withBusy("assign", async () => {
    const results = await Promise.allSettled(
      props.selectedTickets.map((t) =>
        api.PATCH("/v1/tickets/{idOrKey}", {
          params: { path: { idOrKey: t.id } },
          body: { assignee_id: userId ?? undefined } as any,
        })
      )
    );
    const failed = results.filter((r) => r.status === "rejected").length;
    const labelText = userId
      ? users.value.find((u) => u.id === userId)?.name ?? "user"
      : "Unassigned";
    if (failed === 0) toast.success(`Assigned ${count.value} ticket${count.value === 1 ? "" : "s"} to ${labelText}`);
    else toast.error(`Assigned ${count.value - failed}/${count.value}; ${failed} failed`);
  });
}

async function bulkAddLabel(labelId: string) {
  addLabelOpen.value = false;
  await withBusy("add label", async () => {
    const results = await Promise.allSettled(
      props.selectedTickets.map((t) => {
        const next = Array.from(new Set([...t.labels.map((l) => l.id), labelId]));
        return api.PATCH("/v1/tickets/{idOrKey}", {
          params: { path: { idOrKey: t.id } },
          body: { label_ids: next } as any,
        });
      })
    );
    const failed = results.filter((r) => r.status === "rejected").length;
    if (failed === 0) toast.success(`Labeled ${count.value} ticket${count.value === 1 ? "" : "s"}`);
    else toast.error(`Labeled ${count.value - failed}/${count.value}; ${failed} failed`);
  });
}

async function bulkRemoveLabel(labelId: string) {
  removeLabelOpen.value = false;
  await withBusy("remove label", async () => {
    const results = await Promise.allSettled(
      props.selectedTickets.map((t) => {
        const next = t.labels.map((l) => l.id).filter((id) => id !== labelId);
        return api.PATCH("/v1/tickets/{idOrKey}", {
          params: { path: { idOrKey: t.id } },
          body: { label_ids: next } as any,
        });
      })
    );
    const failed = results.filter((r) => r.status === "rejected").length;
    if (failed === 0) toast.success(`Removed label from ${count.value} ticket${count.value === 1 ? "" : "s"}`);
    else toast.error(`Removed from ${count.value - failed}/${count.value}; ${failed} failed`);
  });
}

async function bulkDelete() {
  confirmDelete.value = false;
  await withBusy("delete", async () => {
    const results = await Promise.allSettled(
      props.selectedTickets.map((t) =>
        api.DELETE("/v1/tickets/{idOrKey}", {
          params: { path: { idOrKey: t.id } },
        })
      )
    );
    const failed = results.filter((r) => r.status === "rejected").length;
    if (failed === 0) toast.success(`Deleted ${count.value} ticket${count.value === 1 ? "" : "s"}`);
    else toast.error(`Deleted ${count.value - failed}/${count.value}; ${failed} failed`);
  });
}

// ─── searchable filters inside popovers ────────────────────────────────────

const userSearch = ref("");
const filteredUsers = computed(() => {
  const q = userSearch.value.trim().toLowerCase();
  if (!q) return users.value;
  return users.value.filter((u) => u.name.toLowerCase().includes(q));
});

const addLabelSearch = ref("");
const filteredAddLabels = computed(() => {
  const q = addLabelSearch.value.trim().toLowerCase();
  if (!q) return labels.value;
  return labels.value.filter((l) => l.name.toLowerCase().includes(q));
});
</script>

<template>
  <Transition
    enter-active-class="transition-all duration-150 ease-out"
    enter-from-class="opacity-0 translate-y-2"
    enter-to-class="opacity-100 translate-y-0"
    leave-active-class="transition-all duration-100 ease-in"
    leave-from-class="opacity-100 translate-y-0"
    leave-to-class="opacity-0 translate-y-2"
  >
    <div
      v-if="visible"
      class="fixed bottom-6 left-1/2 -translate-x-1/2 z-40 flex items-center gap-1 rounded-lg border bg-popover shadow-lg shadow-black/10 px-3 py-2"
      role="toolbar"
      aria-label="Bulk actions"
    >
      <span class="text-sm font-medium tabular-nums px-1">
        {{ count }} selected
      </span>

      <!-- Delete confirm replaces the action row inline (no overlay). The
           count-selected label above stays visible so context is preserved. -->
      <template v-if="confirmDelete">
        <span class="text-sm text-muted-foreground">
          Delete {{ count }} ticket{{ count === 1 ? "" : "s" }}? Soft-delete is recoverable.
        </span>
        <div class="h-6 w-px bg-border mx-1" />
        <Button variant="ghost" size="sm" class="h-7" @click="confirmDelete = false">
          Cancel
        </Button>
        <Button
          variant="destructive"
          size="sm"
          class="h-7"
          :disabled="busy"
          @click="bulkDelete"
        >
          <Loader2 v-if="busy" class="h-3.5 w-3.5 mr-1.5 animate-spin" />
          Confirm delete
        </Button>
      </template>

      <template v-else>
      <Button
        variant="ghost"
        size="sm"
        class="h-7 px-2 text-muted-foreground"
        :disabled="busy"
        @click="emit('clear')"
      >
        <X class="h-3.5 w-3.5 mr-1" /> Clear
      </Button>

      <div class="h-6 w-px bg-border mx-1" />

      <!-- Assign to... -->
      <Popover v-model:open="assignOpen">
        <PopoverTrigger as-child>
          <Button variant="ghost" size="sm" class="h-7" :disabled="busy">
            <UserPlus class="h-3.5 w-3.5 mr-1.5" /> Assign
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" class="w-64 p-0">
          <Command>
            <CommandInput v-model="userSearch" placeholder="Search users…" />
            <CommandList>
              <CommandEmpty>No users found.</CommandEmpty>
              <CommandGroup>
                <CommandItem value="unassigned" @select="bulkAssign(null)">
                  <X class="h-3.5 w-3.5 mr-2 text-muted-foreground" />
                  Unassigned
                </CommandItem>
                <CommandItem
                  v-for="u in filteredUsers"
                  :key="u.id"
                  :value="u.id"
                  @select="bulkAssign(u.id)"
                >
                  <Check class="h-3.5 w-3.5 mr-2 text-muted-foreground opacity-0" />
                  <span class="flex-1 truncate">{{ u.name }}</span>
                  <span class="ml-2 text-[10px] text-muted-foreground">{{ u.type }}</span>
                </CommandItem>
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>

      <!-- Add label... -->
      <Popover v-model:open="addLabelOpen">
        <PopoverTrigger as-child>
          <Button variant="ghost" size="sm" class="h-7" :disabled="busy">
            <Tag class="h-3.5 w-3.5 mr-1.5" /> Add label
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" class="w-64 p-0">
          <Command>
            <CommandInput v-model="addLabelSearch" placeholder="Search labels…" />
            <CommandList>
              <CommandEmpty>No labels found.</CommandEmpty>
              <CommandGroup>
                <CommandItem
                  v-for="l in filteredAddLabels"
                  :key="l.id"
                  :value="l.id"
                  @select="bulkAddLabel(l.id)"
                >
                  <span
                    class="h-2.5 w-2.5 rounded-full mr-2 shrink-0"
                    :style="{ backgroundColor: l.color ?? '#94a3b8' }"
                  />
                  <span class="truncate">{{ l.name }}</span>
                </CommandItem>
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>

      <!-- Remove label... — only shown when at least one selected ticket has a label -->
      <Popover v-if="labelsOnSelection.length > 0" v-model:open="removeLabelOpen">
        <PopoverTrigger as-child>
          <Button variant="ghost" size="sm" class="h-7" :disabled="busy">
            <Tag class="h-3.5 w-3.5 mr-1.5 line-through opacity-60" /> Remove label
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" class="w-64 p-0">
          <Command>
            <CommandInput placeholder="Remove which label?" />
            <CommandList>
              <CommandEmpty>No labels to remove.</CommandEmpty>
              <CommandGroup>
                <CommandItem
                  v-for="l in labelsOnSelection"
                  :key="l.id"
                  :value="l.id"
                  @select="bulkRemoveLabel(l.id)"
                >
                  <span
                    class="h-2.5 w-2.5 rounded-full mr-2 shrink-0"
                    :style="{ backgroundColor: l.color ?? '#94a3b8' }"
                  />
                  <span class="truncate">{{ l.name }}</span>
                </CommandItem>
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>

      <!-- Move to status... -->
      <Button
        variant="ghost"
        size="sm"
        class="h-7"
        :disabled="busy"
        @click="transitionOpen = true"
      >
        <MoveRight class="h-3.5 w-3.5 mr-1.5" /> Move to…
      </Button>

      <div class="h-6 w-px bg-border mx-1" />

      <!-- Delete (opens inline confirm above, replacing this row) -->
      <Button
        variant="ghost"
        size="sm"
        class="h-7 text-destructive hover:text-destructive hover:bg-destructive/10"
        :disabled="busy"
        @click="confirmDelete = true"
      >
        <Trash2 class="h-3.5 w-3.5 mr-1.5" /> Delete
      </Button>

      <Loader2 v-if="busy" class="h-4 w-4 animate-spin text-muted-foreground ml-1" />
      </template>
    </div>
  </Transition>

  <BulkTransitionModal
    v-model:open="transitionOpen"
    :selected-tickets="selectedTickets"
    :project-keys="projects"
    @done="() => { invalidateAfterMutation(); emit('clear'); }"
  />
</template>
