<script setup lang="ts">
import { computed, ref, watch, useTemplateRef } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/vue-query";
import { Loader2, Bug, CheckSquare2, Lightbulb, Mountain, ListTree } from "lucide-vue-next";
import { toast } from "vue-sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { api } from "@/lib/api";
import { queryKeys } from "@/lib/queryKeys";
import { useMentionAutocomplete } from "@/composables/useMentionAutocomplete";
import MentionAutocomplete from "@/components/MentionAutocomplete.vue";
import type { TicketType, Priority, UserRef } from "@switchyard/shared";

const props = defineProps<{
  open: boolean;
  // Optional pre-selection. The parent passes its current context (e.g. the
  // project filter or the project board's key) so users land on the right
  // project without having to pick it every time.
  defaultProjectKey?: string | null;
  // Optional parent. Set when launched from a ticket's "Add sub-ticket/subtask"
  // button so the new ticket lands under that parent automatically.
  defaultParentId?: string | null;
  // Optional preselected type. "Add sub-ticket" on an epic passes "task"; "Add
  // subtask" on a task/bug/spike passes "subtask".
  defaultType?: TicketType;
}>();

const emit = defineEmits<{ "update:open": [value: boolean] }>();

const route = useRoute();
const router = useRouter();
const qc = useQueryClient();

const projectKey = ref<string>("");
const title = ref("");
const type = ref<TicketType>("task");
const priority = ref<Priority | "__none__">("__none__");
const parentId = ref<string | "__none__">("__none__");
const description = ref("");
const titleInput = useTemplateRef<HTMLInputElement>("titleInput");
const descTextarea = useTemplateRef<HTMLTextAreaElement>("descTextarea");

// User list cached against the canonical key — likely already loaded by
// FilterBar / BulkActionBar elsewhere in the session.
const usersQuery = useQuery({
  queryKey: queryKeys.users(),
  enabled: computed(() => props.open),
  staleTime: 5 * 60 * 1000,
  queryFn: async () => {
    const { data, error } = await api.GET("/v1/users", { params: { query: { limit: 200 } } });
    if (error) throw error;
    return data;
  },
});
const users = computed<UserRef[]>(() => usersQuery.data.value?.items ?? []);

const mention = useMentionAutocomplete({
  textareaRef: descTextarea,
  bodyRef: description,
  users,
});

watch(() => props.open, (v) => {
  if (!v) return;
  title.value = "";
  type.value = props.defaultType ?? "task";
  priority.value = "__none__";
  parentId.value = props.defaultParentId ?? "__none__";
  description.value = "";
  projectKey.value = props.defaultProjectKey ?? "";
  // Focus the title field once Vue renders it.
  void Promise.resolve().then(() => titleInput.value?.focus());
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

// Candidate parents in the selected project, scoped to the hierarchy: a
// task/bug/spike parents under an epic, a subtask under a task/bug/spike.
// (Epics take no parent — the picker is hidden for them.) Parents must be in
// the SAME project (server-enforced), so the query is scoped accordingly.
const parentTypeFilter = computed(() =>
  type.value === "subtask" ? "task,bug,spike" : "epic",
);
const parentNoun = computed(() => (type.value === "subtask" ? "ticket" : "epic"));

const parentsQuery = useQuery({
  queryKey: computed(() => ["sw", "tickets", "parents", projectKey.value, parentTypeFilter.value]),
  enabled: computed(() => props.open && projectKey.value.length > 0 && type.value !== "epic"),
  staleTime: 5 * 60 * 1000,
  queryFn: async () => {
    const { data, error } = await api.GET("/v1/tickets", {
      params: { query: { project: projectKey.value, type: parentTypeFilter.value, limit: 200 } },
    });
    if (error) throw error;
    return data;
  },
});
const parentCandidates = computed(() => parentsQuery.data.value?.items ?? []);

// Changing the project or the type invalidates a previously-picked parent (it
// belonged to the old project, or is the wrong type now). Only clear once the
// new candidate list has actually loaded — otherwise an in-flight fetch would
// wrongly drop a valid preset.
watch([projectKey, parentCandidates], () => {
  if (parentId.value === "__none__") return;
  if (parentsQuery.isFetching.value) return;
  if (!parentCandidates.value.some((e) => e.id === parentId.value)) {
    parentId.value = "__none__";
  }
});

// If the parent didn't pass a default and the user's URL has a single project
// filter, pull from there. Falls back to the first project alphabetically.
watch(projects, (list) => {
  if (projectKey.value || !list.length) return;
  const fromQuery = (route.query.project as string | undefined)?.split(",")[0]?.trim();
  if (fromQuery && list.some((p) => p.key === fromQuery)) {
    projectKey.value = fromQuery;
    return;
  }
  projectKey.value = list[0]!.key;
});

const TYPE_OPTIONS: Array<{ value: TicketType; label: string; icon: any }> = [
  { value: "task", label: "Task", icon: CheckSquare2 },
  { value: "bug", label: "Bug", icon: Bug },
  { value: "spike", label: "Spike", icon: Lightbulb },
  { value: "epic", label: "Epic", icon: Mountain },
  { value: "subtask", label: "Subtask", icon: ListTree },
];

// A subtask is never free-floating — it must have a parent.
const needsParent = computed(() => type.value === "subtask");

const canSubmit = computed(() =>
  title.value.trim().length > 0 &&
  projectKey.value.length > 0 &&
  (!needsParent.value || parentId.value !== "__none__")
);

const createMutation = useMutation({
  mutationFn: async () => {
    const body: Record<string, unknown> = {
      project_key: projectKey.value,
      type: type.value,
      title: title.value.trim(),
    };
    if (description.value.trim()) body.description = description.value.trim();
    if (priority.value !== "__none__") body.priority = priority.value;
    if (parentId.value !== "__none__") body.parent_id = parentId.value;

    const { data, error } = await api.POST("/v1/tickets", {
      body: body as never,
    });
    if (error) throw error;
    return data;
  },
  onSuccess: (ticket) => {
    qc.invalidateQueries({ queryKey: ["sw", "tickets"] });
    qc.invalidateQueries({ queryKey: ["sw", "projects", projectKey.value, "board"] });
    qc.invalidateQueries({ queryKey: ["sw", "boards"] });
    // Refresh the parent's children list + detail when this was a child.
    if (parentId.value !== "__none__") {
      qc.invalidateQueries({ queryKey: queryKeys.ticketChildren(parentId.value) });
      qc.invalidateQueries({ queryKey: queryKeys.ticket(parentId.value) });
    }
    toast.success(`${ticket?.key ?? "Ticket"} created`);
    emit("update:open", false);
    if (ticket?.key) {
      router.replace({ query: { ...route.query, focus: ticket.key } });
    }
  },
});

function onKeydown(e: KeyboardEvent) {
  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
    e.preventDefault();
    if (canSubmit.value) createMutation.mutate();
  }
}
</script>

<template>
  <Dialog :open="open" @update:open="(v) => emit('update:open', v)">
    <DialogContent class="sm:max-w-lg">
      <!-- @keydown sits on a real DOM wrapper because radix's DialogContent
           renders through a portal and complains about extraneous listeners
           that can't be inherited onto a fragment. -->
      <div @keydown="onKeydown">
      <DialogHeader>
        <DialogTitle>New ticket</DialogTitle>
        <DialogDescription>
          Ctrl+Enter to create. The drawer opens to the new ticket on success.
        </DialogDescription>
      </DialogHeader>

      <div class="space-y-3.5">
        <div class="space-y-1.5">
          <Label for="t-title">Title</Label>
          <Input
            id="t-title"
            ref="titleInput"
            v-model="title"
            placeholder="What needs to happen?"
          />
        </div>

        <div class="grid grid-cols-2 gap-3">
          <div class="space-y-1.5">
            <Label>Project</Label>
            <Select v-model="projectKey">
              <SelectTrigger class="w-full">
                <!-- Trigger shows just the key (e.g. SAMPLE), not the
                     concatenated key+name. SelectValue's default rendering
                     glues the inner SelectItem text together with no
                     separator, which reads as "SAMPLESample Project". -->
                <span v-if="projectKey" class="font-mono">{{ projectKey }}</span>
                <SelectValue v-else placeholder="Pick a project" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem v-for="p in projects" :key="p.id" :value="p.key">
                  <span class="font-mono">{{ p.key }}</span>
                  <span class="ml-2 text-muted-foreground">{{ p.name }}</span>
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div class="space-y-1.5">
            <Label>Type</Label>
            <Select v-model="type">
              <SelectTrigger class="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem
                  v-for="o in TYPE_OPTIONS"
                  :key="o.value"
                  :value="o.value"
                >
                  <span class="inline-flex items-center gap-2">
                    <component :is="o.icon" class="h-3.5 w-3.5" />
                    {{ o.label }}
                  </span>
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        <div class="space-y-1.5">
          <Label>Priority</Label>
          <Select v-model="priority">
            <SelectTrigger class="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__none__">No priority</SelectItem>
              <SelectItem value="low">Low</SelectItem>
              <SelectItem value="medium">Medium</SelectItem>
              <SelectItem value="high">High</SelectItem>
              <SelectItem value="critical">Critical</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <!-- Parent — offered for non-epic types (epics can't nest): an epic for
             a task/bug/spike, a task/bug/spike for a subtask. Shown when there
             are candidates, or always for a subtask (which requires one). -->
        <div v-if="type !== 'epic' && (parentCandidates.length > 0 || needsParent)" class="space-y-1.5">
          <Label>Parent {{ parentNoun }}<span v-if="needsParent" class="text-destructive"> *</span></Label>
          <Select v-model="parentId">
            <SelectTrigger class="w-full">
              <SelectValue :placeholder="`Pick a parent ${parentNoun}`" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem v-if="!needsParent" value="__none__">No parent</SelectItem>
              <SelectItem v-for="e in parentCandidates" :key="e.id" :value="e.id">
                <span class="font-mono text-xs">{{ e.key }}</span>
                <span class="ml-2">{{ e.title }}</span>
              </SelectItem>
            </SelectContent>
          </Select>
          <p v-if="needsParent && parentCandidates.length === 0 && !parentsQuery.isFetching.value"
             class="text-xs text-muted-foreground">
            This project has no task, bug, or spike to attach a subtask to yet.
          </p>
        </div>

        <div class="space-y-1.5">
          <Label for="t-description">Description (markdown)</Label>
          <div class="relative">
            <textarea
              id="t-description"
              ref="descTextarea"
              v-model="description"
              rows="4"
              class="w-full rounded-md border bg-background px-3 py-2 text-sm font-mono leading-relaxed focus:outline-none focus:ring-1 focus:ring-ring resize-y"
              placeholder="Optional. Markdown supported."
              @input="mention.onInput"
              @keydown="(e) => { if (mention.onKeydown(e)) e.stopPropagation(); }"
              @blur="mention.onBlur"
            />
            <MentionAutocomplete
              :open="mention.open.value"
              :users="mention.filtered.value"
              :selected-index="mention.selectedIndex.value"
              @pick="mention.pick"
            />
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
          Create ticket
        </Button>
      </DialogFooter>
      </div>
    </DialogContent>
  </Dialog>
</template>
