<script setup lang="ts">
import { ref, computed, useTemplateRef, watch } from "vue";
import { useMutation, useQuery, useQueryClient } from "@tanstack/vue-query";
import { Pencil, Loader2 } from "lucide-vue-next";
import { toast } from "vue-sonner";
import { Button } from "@/components/ui/button";
import Markdown from "@/components/markdown/Markdown.vue";
import { api } from "@/lib/api";
import { queryKeys } from "@/lib/queryKeys";
import { useMentionAutocomplete } from "@/composables/useMentionAutocomplete";
import MentionAutocomplete from "@/components/MentionAutocomplete.vue";
import type { Ticket, UserRef } from "@switchyard/shared";

const props = defineProps<{ ticket: Ticket }>();

const editing = ref(false);
const draft = ref("");
const textarea = useTemplateRef<HTMLTextAreaElement>("textarea");
const qc = useQueryClient();

// User list for @mention autocomplete. Same canonical queryKey as the
// rest of the app so the cache is shared.
const usersQuery = useQuery({
  queryKey: queryKeys.users(),
  enabled: computed(() => editing.value),
  staleTime: 5 * 60 * 1000,
  queryFn: async () => {
    const { data, error } = await api.GET("/v1/users", { params: { query: { limit: 200 } } });
    if (error) throw error;
    return data;
  },
});
const users = computed<UserRef[]>(() => usersQuery.data.value?.items ?? []);

const mention = useMentionAutocomplete({ textareaRef: textarea, bodyRef: draft, users });

watch(
  () => props.ticket.id,
  () => { editing.value = false; },
);

function startEdit() {
  draft.value = props.ticket.description;
  editing.value = true;
  void Promise.resolve().then(() => textarea.value?.focus());
}

function cancel() {
  editing.value = false;
}

const saveMutation = useMutation({
  mutationFn: async (description: string) => {
    const { data, error } = await api.PATCH("/v1/tickets/{idOrKey}", {
      params: { path: { idOrKey: props.ticket.key } },
      body: { description },
    });
    if (error) throw error;
    return data;
  },
  onSuccess: () => {
    qc.invalidateQueries({ queryKey: queryKeys.ticket(props.ticket.key) });
    qc.invalidateQueries({ queryKey: queryKeys.ticket(props.ticket.id) });
    qc.invalidateQueries({ queryKey: queryKeys.ticketEvents(props.ticket.key) });
    toast.success("Description updated");
    editing.value = false;
  },
});

const saving = computed(() => saveMutation.isPending.value);

function save() {
  if (saving.value) return;
  saveMutation.mutate(draft.value);
}

function onKeydown(e: KeyboardEvent) {
  // Mention autocomplete claims arrow keys / Enter / Tab / Escape when
  // its popover is open. Fall through to the editor's own shortcuts
  // otherwise.
  if (mention.onKeydown(e)) return;
  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
    e.preventDefault();
    save();
  } else if (e.key === "Escape") {
    e.preventDefault();
    cancel();
  }
}
</script>

<template>
  <section>
    <div class="flex items-center justify-between mb-1.5">
      <h3 class="text-xs uppercase tracking-wider text-muted-foreground">Description</h3>
      <Button v-if="!editing" variant="ghost" size="sm" class="h-6 text-xs text-muted-foreground" @click="startEdit">
        <Pencil class="h-3 w-3 mr-1" /> Edit
      </Button>
    </div>

    <div v-if="editing" class="space-y-2">
      <div class="relative">
        <textarea
          ref="textarea"
          v-model="draft"
          rows="8"
          class="w-full rounded-md border bg-background px-3 py-2 text-sm font-mono leading-relaxed focus:outline-none focus:ring-1 focus:ring-ring resize-y"
          placeholder="Markdown supported. Ctrl+Enter to save, Esc to cancel."
          @input="mention.onInput"
          @keydown="onKeydown"
          @blur="mention.onBlur"
        />
        <MentionAutocomplete
          :open="mention.open.value"
          :users="mention.filtered.value"
          :selected-index="mention.selectedIndex.value"
          @pick="mention.pick"
        />
      </div>
      <div class="flex items-center justify-end gap-2">
        <Button variant="ghost" size="sm" :disabled="saving" @click="cancel">Cancel</Button>
        <Button size="sm" :disabled="saving" @click="save">
          <Loader2 v-if="saving" class="h-3.5 w-3.5 mr-1.5 animate-spin" />
          Save
        </Button>
      </div>
    </div>

    <Markdown v-else-if="ticket.description" :body="ticket.description" />
    <p v-else class="text-sm text-muted-foreground italic">No description.</p>
  </section>
</template>
