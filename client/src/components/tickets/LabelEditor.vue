<script setup lang="ts">
import { computed, ref } from "vue";
import { useMutation, useQuery, useQueryClient } from "@tanstack/vue-query";
import { Plus, X, Check, Loader2 } from "lucide-vue-next";
import { toast } from "vue-sonner";
import {
  Popover, PopoverContent, PopoverTrigger,
} from "@/components/ui/popover";
import { Input } from "@/components/ui/input";
import LabelChip from "./LabelChip.vue";
import { api } from "@/lib/api";
import { queryKeys } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import { useTicketCanWrite } from "@/composables/useProjectPermissions";
import type { Ticket } from "@switchyard/shared";

const props = defineProps<{ ticket: Ticket }>();

const canWrite = useTicketCanWrite();
const qc = useQueryClient();
const open = ref(false);
const search = ref("");

// Global label catalog (one shared list across all projects). Loaded only
// when the popover first opens; staleTime keeps it warm for follow-up edits.
const labelsQuery = useQuery({
  queryKey: queryKeys.labels(),
  enabled: open,
  staleTime: 5 * 60 * 1000,
  queryFn: async () => {
    const { data, error } = await api.GET("/v1/labels");
    if (error) throw error;
    return data;
  },
});

const filteredLabels = computed(() => {
  const all = labelsQuery.data.value?.items ?? [];
  const q = search.value.trim().toLowerCase();
  if (!q) return all;
  return all.filter((l) => l.name.toLowerCase().includes(q));
});

const selectedSet = computed(() => new Set(props.ticket.labels.map((l) => l.id)));

const mutation = useMutation({
  mutationFn: async (label_ids: string[]) => {
    const { data, error } = await api.PATCH("/v1/tickets/{idOrKey}", {
      params: { path: { idOrKey: props.ticket.key } },
      body: { label_ids } as never,
    });
    if (error) throw error;
    return data;
  },
  onSuccess: () => {
    qc.invalidateQueries({ queryKey: queryKeys.ticket(props.ticket.key) });
    qc.invalidateQueries({ queryKey: queryKeys.ticket(props.ticket.id) });
    qc.invalidateQueries({ queryKey: queryKeys.ticketEvents(props.ticket.key) });
    qc.invalidateQueries({ queryKey: ["sw", "tickets"] });
    qc.invalidateQueries({ queryKey: ["sw", "projects"] });
    qc.invalidateQueries({ queryKey: ["sw", "boards"] });
  },
  onError: () => {
    toast.error("Failed to update labels");
  },
});

function toggle(id: string) {
  const next = new Set(selectedSet.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  mutation.mutate(Array.from(next));
}

function remove(id: string) {
  mutation.mutate(props.ticket.labels.filter((l) => l.id !== id).map((l) => l.id));
}
</script>

<template>
  <div class="inline-flex flex-wrap items-center gap-1.5">
    <span
      v-for="lbl in ticket.labels"
      :key="lbl.id"
      class="group inline-flex items-center gap-1 rounded-md border px-1.5 h-5 text-[10px] font-medium text-foreground/80 whitespace-nowrap"
      :style="{ backgroundColor: `${lbl.color}1f`, borderColor: `${lbl.color}55` }"
    >
      <span class="inline-block h-1.5 w-1.5 rounded-full" :style="{ backgroundColor: lbl.color }" />
      {{ lbl.name }}
      <button
        v-if="canWrite"
        type="button"
        class="ml-0.5 rounded p-0.5 opacity-0 group-hover:opacity-100 transition-opacity hover:bg-foreground/10"
        :aria-label="`Remove ${lbl.name}`"
        :disabled="mutation.isPending.value"
        @click="remove(lbl.id)"
      >
        <X class="h-2.5 w-2.5" />
      </button>
    </span>

    <!-- No labels + read-only: show a muted placeholder so the row isn't empty. -->
    <span v-if="!canWrite && ticket.labels.length === 0" class="text-xs text-muted-foreground italic">
      No labels
    </span>

    <Popover v-if="canWrite" v-model:open="open">
      <PopoverTrigger as-child>
        <button
          type="button"
          :class="cn(
            'inline-flex items-center gap-1 rounded-md border border-dashed px-1.5 h-5 text-[10px] text-muted-foreground hover:text-foreground hover:border-foreground/40 transition-colors',
            mutation.isPending.value && 'opacity-60',
          )"
          :disabled="mutation.isPending.value"
        >
          <Loader2 v-if="mutation.isPending.value" class="h-2.5 w-2.5 animate-spin" />
          <Plus v-else class="h-2.5 w-2.5" />
          {{ ticket.labels.length === 0 ? "Add label" : "" }}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" class="w-64 p-0">
        <div class="p-2 border-b">
          <Input
            v-model="search"
            placeholder="Search labels…"
            class="h-7 text-xs"
            autofocus
          />
        </div>
        <div class="max-h-56 overflow-auto py-1">
          <button
            v-for="lbl in filteredLabels"
            :key="lbl.id"
            type="button"
            class="flex w-full items-center gap-2 px-2 py-1.5 text-sm hover:bg-accent text-left"
            @click="toggle(lbl.id)"
          >
            <Check
              :class="cn('h-3.5 w-3.5', selectedSet.has(lbl.id) ? 'text-primary' : 'opacity-0')"
            />
            <LabelChip :label="lbl" />
          </button>
          <p
            v-if="!labelsQuery.isLoading.value && filteredLabels.length === 0"
            class="px-2 py-2 text-xs text-muted-foreground italic"
          >
            <template v-if="search">No labels match "{{ search }}".</template>
            <template v-else>
              No labels yet. Create them in
              <span class="font-mono">/settings/labels</span>
              (lands in milestone 2.6).
            </template>
          </p>
        </div>
      </PopoverContent>
    </Popover>
  </div>
</template>
