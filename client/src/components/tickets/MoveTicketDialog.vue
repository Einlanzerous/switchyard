<script setup lang="ts">
// Move a ticket between projects. Backend allocates a new key
// (e.g. LOOP-3 → SWY-71) and records the old key as an alias so any
// cached reference (n8n payloads, GitHub PR titles, agent state) keeps
// working. Status mapping is server-driven with a fallback chain; we
// show a 400 with candidates here when ambiguous so the user picks one.

import { computed, ref, watch } from "vue";
import { useMutation, useQuery, useQueryClient } from "@tanstack/vue-query";
import { Loader2 } from "lucide-vue-next";
import { toast } from "vue-sonner";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/api";
import { queryKeys } from "@/lib/queryKeys";
import type { Ticket } from "@switchyard/shared";

const props = defineProps<{ open: boolean; ticket: Ticket }>();
const emit = defineEmits<{
  "update:open": [v: boolean];
  moved: [newKey: string];
}>();

const qc = useQueryClient();
const destKey = ref<string>("");
// Filled when the server returns 400 status_mapping_ambiguous — the user
// then picks one of the candidates and resubmits.
const ambiguousCandidates = ref<Array<{ id: string; display_name: string; category: string }>>([]);
const pickedStatusId = ref<string | null>(null);

// Reset on open.
watch(() => props.open, (open) => {
  if (!open) return;
  destKey.value = "";
  ambiguousCandidates.value = [];
  pickedStatusId.value = null;
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
const projectOptions = computed(() =>
  (projectsQuery.data.value?.items ?? []).filter((p) => p.key !== props.ticket.project.key),
);

const mut = useMutation({
  mutationFn: async () => {
    const body: Record<string, unknown> = { project_key: destKey.value };
    if (pickedStatusId.value) body.status_id = pickedStatusId.value;
    const { data, error } = await api.POST("/v1/tickets/{idOrKey}/move", {
      params: { path: { idOrKey: props.ticket.key } },
      body: body as never,
    });
    if (error) throw error;
    return data;
  },
  onSuccess: (data) => {
    if (!data) return;
    qc.invalidateQueries({ queryKey: queryKeys.ticket(props.ticket.key) });
    qc.invalidateQueries({ queryKey: queryKeys.ticket(data.key) });
    qc.invalidateQueries({ queryKey: queryKeys.tickets() });
    qc.invalidateQueries({ queryKey: ["sw", "projects"] });
    qc.invalidateQueries({ queryKey: ["sw", "boards"] });
    toast.success(`Moved to ${data.key}`);
    emit("moved", data.key);
    emit("update:open", false);
  },
  onError: (err) => {
    const e = err as { error?: { code?: string; message?: string; details?: { candidates?: typeof ambiguousCandidates.value } } };
    // Server flagged the move as ambiguous — surface the candidates so
    // the user can pick the right destination status without a 400 loop.
    if (e?.error?.details?.candidates) {
      ambiguousCandidates.value = e.error.details.candidates;
      pickedStatusId.value = null;
      return;
    }
    toast.error(e?.error?.message ?? "Move failed");
  },
});

const canSubmit = computed(() => {
  if (!destKey.value) return false;
  if (ambiguousCandidates.value.length > 0 && !pickedStatusId.value) return false;
  return !mut.isPending.value;
});
</script>

<template>
  <Dialog :open="open" @update:open="(v) => emit('update:open', v)">
    <DialogContent class="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>Move {{ ticket.key }}</DialogTitle>
        <DialogDescription>
          Allocates a new key in the destination project. The old key keeps
          resolving forever, so anything that cached <span class="font-mono">{{ ticket.key }}</span>
          (agents, GitHub references, n8n payloads) keeps working.
        </DialogDescription>
      </DialogHeader>

      <div class="space-y-4 py-2">
        <div class="space-y-1.5">
          <Label for="move-dest">Destination project</Label>
          <select
            id="move-dest"
            v-model="destKey"
            class="w-full rounded-md border bg-background px-2 py-1.5 text-sm"
          >
            <option value="" disabled>Pick a project…</option>
            <option v-for="p in projectOptions" :key="p.id" :value="p.key">
              {{ p.key }} — {{ p.name }}
            </option>
          </select>
        </div>

        <div v-if="ambiguousCandidates.length > 0" class="space-y-1.5 rounded-md border border-amber-500/30 bg-amber-500/10 p-3">
          <Label class="text-xs text-amber-700 dark:text-amber-300">
            Pick the destination status (multiple match the source category)
          </Label>
          <select
            v-model="pickedStatusId"
            class="w-full rounded-md border bg-background px-2 py-1.5 text-sm"
          >
            <option :value="null" disabled>Choose a status…</option>
            <option v-for="c in ambiguousCandidates" :key="c.id" :value="c.id">
              {{ c.display_name }} ({{ c.category }})
            </option>
          </select>
        </div>

        <p class="text-[11px] text-muted-foreground">
          Comments, attachments, links, custom-field metadata, and external
          references all come along automatically.
        </p>
      </div>

      <DialogFooter>
        <Button variant="ghost" @click="emit('update:open', false)">Cancel</Button>
        <Button :disabled="!canSubmit" @click="mut.mutate()">
          <Loader2 v-if="mut.isPending.value" class="h-3.5 w-3.5 mr-1 animate-spin" />
          Move ticket
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
