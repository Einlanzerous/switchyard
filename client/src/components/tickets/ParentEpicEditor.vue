<script setup lang="ts">
import { computed, ref } from "vue";
import { useMutation, useQuery, useQueryClient } from "@tanstack/vue-query";
import { ChevronDown, Check, Loader2, Mountain } from "lucide-vue-next";
import { toast } from "vue-sonner";
import {
  Popover, PopoverContent, PopoverTrigger,
} from "@/components/ui/popover";
import { Input } from "@/components/ui/input";
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

// Parents must be epics in the SAME project — the server enforces this, but we
// also scope the picker so the user never sees an invalid choice.
const projectKey = computed(() => props.ticket.project.key);

// Loaded eagerly (not gated on `open`) so the trigger can resolve the current
// parent's key/title — the Ticket payload carries only `parent_id`, not an
// embedded parent object.
const epicsQuery = useQuery({
  queryKey: computed(() => ["sw", "tickets", "epics", projectKey.value]),
  staleTime: 5 * 60 * 1000,
  queryFn: async () => {
    const { data, error } = await api.GET("/v1/tickets", {
      params: { query: { project: projectKey.value, type: "epic", limit: 200 } },
    });
    if (error) throw error;
    return data;
  },
});

const epics = computed(() => epicsQuery.data.value?.items ?? []);

// The current parent, resolved from the epics list (Ticket has no embedded
// parent object). Falls back to null while loading or if the parent is missing.
const currentParent = computed(() =>
  props.ticket.parent_id
    ? epics.value.find((e) => e.id === props.ticket.parent_id) ?? null
    : null,
);

// The ticket itself can't be its own parent (and epics can't nest), so drop the
// current ticket from the list defensively.
const filteredEpics = computed(() => {
  const all = epics.value.filter((e) => e.id !== props.ticket.id);
  const q = search.value.trim().toLowerCase();
  if (!q) return all;
  return all.filter((e) =>
    e.title.toLowerCase().includes(q) || e.key.toLowerCase().includes(q),
  );
});

const mutation = useMutation({
  mutationFn: async (epicId: string | null) => {
    const { data, error } = await api.PATCH("/v1/tickets/{idOrKey}", {
      params: { path: { idOrKey: props.ticket.key } },
      body: { parent_id: epicId } as never,
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
    toast.success("Parent updated");
    open.value = false;
  },
  onError: (err: unknown) => {
    const msg = (err as { error?: { message?: string } })?.error?.message ?? "Failed to update parent";
    toast.error(msg);
  },
});

function pick(id: string | null) {
  mutation.mutate(id);
}
</script>

<template>
  <Popover v-model:open="open">
    <PopoverTrigger as-child>
      <button
        type="button"
        :class="cn(
          'inline-flex items-center gap-1.5 rounded px-1.5 py-0.5 text-sm hover:bg-accent transition-colors',
          mutation.isPending.value && 'opacity-60',
        )"
        :disabled="mutation.isPending.value || !canWrite"
      >
        <Loader2 v-if="mutation.isPending.value" class="h-3.5 w-3.5 animate-spin" />
        <template v-else-if="currentParent">
          <Mountain class="h-3.5 w-3.5 text-muted-foreground" />
          <span class="font-mono text-xs text-muted-foreground">{{ currentParent.key }}</span>
          <span class="text-foreground truncate max-w-[12rem]">{{ currentParent.title }}</span>
        </template>
        <span v-else class="inline-flex items-center gap-1.5 text-muted-foreground">
          <Mountain class="h-3.5 w-3.5" /> No parent
        </span>
        <ChevronDown v-if="canWrite" class="h-3 w-3 text-muted-foreground/60" />
      </button>
    </PopoverTrigger>
    <PopoverContent align="start" class="w-72 p-0">
      <div class="p-2 border-b">
        <Input
          v-model="search"
          placeholder="Search epics…"
          class="h-7 text-xs"
          autofocus
        />
      </div>
      <div class="max-h-56 overflow-auto py-1">
        <button
          type="button"
          class="flex w-full items-center gap-2 px-2 py-1.5 text-sm hover:bg-accent text-left"
          @click="pick(null)"
        >
          <Check
            :class="cn('h-3.5 w-3.5', !ticket.parent_id ? 'text-primary' : 'opacity-0')"
          />
          <Mountain class="h-3.5 w-3.5 text-muted-foreground" />
          <span class="italic text-muted-foreground">No parent</span>
        </button>
        <div v-if="epicsQuery.isLoading.value" class="px-2 py-2 text-xs text-muted-foreground italic">
          Loading epics…
        </div>
        <button
          v-for="e in filteredEpics"
          :key="e.id"
          type="button"
          class="flex w-full items-center gap-2 px-2 py-1.5 text-sm hover:bg-accent text-left"
          @click="pick(e.id)"
        >
          <Check
            :class="cn('h-3.5 w-3.5', ticket.parent_id === e.id ? 'text-primary' : 'opacity-0')"
          />
          <span class="font-mono text-[10px] text-muted-foreground shrink-0">{{ e.key }}</span>
          <span class="flex-1 truncate">{{ e.title }}</span>
        </button>
        <p
          v-if="!epicsQuery.isLoading.value && filteredEpics.length === 0"
          class="px-2 py-2 text-xs text-muted-foreground italic"
        >
          <template v-if="search">No epics match "{{ search }}".</template>
          <template v-else>No epics in this project yet.</template>
        </p>
      </div>
    </PopoverContent>
  </Popover>
</template>
