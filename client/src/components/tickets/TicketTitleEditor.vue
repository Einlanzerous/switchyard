<script setup lang="ts">
import { ref, computed, useTemplateRef, nextTick, watch } from "vue";
import { useMutation, useQueryClient } from "@tanstack/vue-query";
import { toast } from "vue-sonner";
import { api } from "@/lib/api";
import { queryKeys } from "@/lib/queryKeys";

// Click-to-edit ticket/epic title (Jira-style). Read mode renders the title as
// text; clicking it (only when the viewer can write) swaps to an input seeded
// with the current title. Enter or blur commits, Esc reverts. `textClass`
// carries the mount site's typography — the 26px h1 on the full page, the
// compact drawer header — and is applied to BOTH the span and the input because
// form controls don't inherit font size/weight, so the input must match.
const props = defineProps<{
  ticketKey: string;
  ticketId: string;
  title: string;
  canWrite: boolean;
  textClass?: string;
}>();

const qc = useQueryClient();
const editing = ref(false);
const draft = ref("");
const input = useTemplateRef<HTMLInputElement>("input");

// Bail out of edit mode if the underlying ticket changes (e.g. drawer focus
// swap reuses this component instance for a different ticket).
watch(() => props.ticketId, () => { editing.value = false; });

function startEdit() {
  if (!props.canWrite || editing.value) return;
  draft.value = props.title;
  editing.value = true;
  void nextTick(() => { input.value?.focus(); input.value?.select(); });
}

const saveMutation = useMutation({
  mutationFn: async (title: string) => {
    const { data, error } = await api.PATCH("/v1/tickets/{idOrKey}", {
      params: { path: { idOrKey: props.ticketKey } },
      body: { title },
    });
    if (error) throw error;
    return data;
  },
  onSuccess: () => {
    qc.invalidateQueries({ queryKey: queryKeys.ticket(props.ticketKey) });
    qc.invalidateQueries({ queryKey: queryKeys.ticket(props.ticketId) });
    qc.invalidateQueries({ queryKey: queryKeys.ticketEvents(props.ticketKey) });
    toast.success("Title updated");
    editing.value = false;
  },
  onError: () => { toast.error("Couldn't update the title"); },
});
const saving = computed(() => saveMutation.isPending.value);

// Commit on Enter/blur. The leading `!editing || saving` guard makes this safe
// against the blur that fires when the input unmounts (on Esc, or after a
// successful save) — that stray blur is ignored, so there's no double-save and
// no accidental save-on-cancel. A blank or unchanged title just closes.
function commit() {
  if (!editing.value || saving.value) return;
  const next = draft.value.trim();
  if (!next || next === props.title) { editing.value = false; return; }
  saveMutation.mutate(next);
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === "Enter") { e.preventDefault(); commit(); }
  else if (e.key === "Escape") { e.preventDefault(); editing.value = false; }
}
</script>

<template>
  <input
    v-if="editing"
    ref="input"
    v-model="draft"
    type="text"
    :disabled="saving"
    :class="[textClass, 'w-full min-w-0 bg-transparent border-b border-ring/60 focus:outline-none focus:border-ring disabled:opacity-60']"
    @keydown="onKeydown"
    @blur="commit"
  />
  <span
    v-else
    :class="[textClass, canWrite ? 'cursor-text rounded-sm hover:bg-muted/60 transition-colors' : '']"
    :title="canWrite ? 'Click to edit title' : undefined"
    @click="startEdit"
  >{{ title }}</span>
</template>
