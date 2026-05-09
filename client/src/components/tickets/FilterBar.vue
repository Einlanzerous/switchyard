<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useQuery } from "@tanstack/vue-query";
import {
  Search, X, Bug, CheckSquare2, Lightbulb, Mountain,
} from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { api } from "@/lib/api";
import { queryKeys } from "@/lib/queryKeys";
import { useTicketFilters } from "@/composables/useTicketFilters";
import ChipGroup from "./ChipGroup.vue";

const { filters, set, toggle, clear, isAnySet } = useTicketFilters();

// ─── data sources ────────────────────────────────────────────────────────────
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

const usersQuery = useQuery({
  queryKey: queryKeys.users(),
  staleTime: 5 * 60 * 1000,
  queryFn: async () => {
    const { data, error } = await api.GET("/v1/users", { params: { query: { limit: 200 } } });
    if (error) throw error;
    return data;
  },
});
const users = computed(() => usersQuery.data.value?.items ?? []);

// ─── chip enums ──────────────────────────────────────────────────────────────
const STATUS_OPTIONS = [
  { value: "backlog", label: "Backlog" },
  { value: "planning", label: "Planning" },
  { value: "in_progress", label: "In Progress" },
  { value: "blocked", label: "Blocked" },
  { value: "closed", label: "Closed" },
];
// Type chips include their icon for visual parity with the row icon.
const TYPE_OPTIONS = [
  { value: "task", label: "Task", icon: CheckSquare2 },
  { value: "bug", label: "Bug", icon: Bug },
  { value: "spike", label: "Spike", icon: Lightbulb },
  { value: "epic", label: "Epic", icon: Mountain },
];
const PRIORITY_OPTIONS = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "critical", label: "Critical" },
];

// Single-select Select uses a sentinel for "no filter" because radix's Select
// can't hold an empty string value.
const ALL = "__all__";
const UNASSIGNED = "unassigned";

const projectValue = computed({
  get: () => filters.value.project[0] ?? ALL,
  set: (v: string) => set("project", v === ALL ? [] : [v]),
});

const assigneeValue = computed({
  get: () => filters.value.assignee ?? ALL,
  set: (v: string) => set("assignee", v === ALL ? undefined : v),
});

// Trim project names so the Select trigger and dropdown stay legible at narrow
// widths. The full key is always shown; only the human name is clipped.
function shortName(name: string, max = 22): string {
  return name.length > max ? `${name.slice(0, max - 1).trimEnd()}…` : name;
}

// ─── debounced text search ───────────────────────────────────────────────────
const localText = ref(filters.value.text ?? "");
let textTimer: ReturnType<typeof setTimeout> | null = null;

watch(() => filters.value.text, (v) => {
  if ((v ?? "") !== localText.value) localText.value = v ?? "";
});

watch(localText, (v) => {
  if (textTimer) clearTimeout(textTimer);
  textTimer = setTimeout(() => {
    set("text", v.trim() ? v.trim() : undefined);
  }, 250);
});
</script>

<template>
  <div class="border-b bg-background/95 backdrop-blur sticky top-0 z-10">
    <!-- Search row — alone so it never gets squeezed below readable width.
         The optional `actions` slot lets the parent surface a context-aware
         action (e.g. "Board view" toggle) right-aligned next to the search. -->
    <div class="px-4 pt-2 flex items-center gap-2">
      <div class="relative flex-1 max-w-md">
        <Search class="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          v-model="localText"
          placeholder="Search title or description…"
          class="pl-9 bg-muted/50 border-transparent focus-visible:ring-1 h-8"
        />
      </div>
      <div class="ml-auto flex items-center gap-2">
        <slot name="actions" />
      </div>
    </div>

    <!-- Filter row — Project + Assignee on the left, then chip groups, Clear pinned right.
         Wraps onto multiple lines only when the viewport gets narrow. -->
    <div class="px-4 py-2 flex flex-wrap items-center gap-x-4 gap-y-2">
      <div class="flex flex-wrap items-center gap-2">
        <Select v-model="projectValue">
          <SelectTrigger class="h-8 w-[11rem]">
            <!-- Trigger shows the key only when a project is picked;
                 otherwise the placeholder. SelectValue would glue the inner
                 SelectItem text together as "FLOWFlow Project". -->
            <span v-if="projectValue !== ALL" class="font-mono">{{ projectValue }}</span>
            <SelectValue v-else placeholder="Project" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem :value="ALL">All projects</SelectItem>
            <SelectItem v-for="p in projects" :key="p.id" :value="p.key">
              <span class="font-mono">{{ p.key }}</span>
              <span class="ml-2 text-muted-foreground">{{ shortName(p.name) }}</span>
            </SelectItem>
          </SelectContent>
        </Select>

        <Select v-model="assigneeValue">
          <SelectTrigger class="h-8 w-[10rem] [&>span]:truncate">
            <SelectValue placeholder="Assignee" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem :value="ALL">Anyone</SelectItem>
            <SelectItem :value="UNASSIGNED">Unassigned</SelectItem>
            <SelectItem v-for="u in users" :key="u.id" :value="u.id">
              {{ u.name }}
              <span class="ml-1 text-[10px] text-muted-foreground">({{ u.type }})</span>
            </SelectItem>
          </SelectContent>
        </Select>
      </div>

      <ChipGroup label="Status" :options="STATUS_OPTIONS" :selected="filters.status"
                 @toggle="(v) => toggle('status', v)" />
      <ChipGroup label="Type" :options="TYPE_OPTIONS" :selected="filters.type"
                 @toggle="(v) => toggle('type', v)" />
      <ChipGroup label="Priority" :options="PRIORITY_OPTIONS" :selected="filters.priority"
                 @toggle="(v) => toggle('priority', v)" />

      <Button
        v-if="isAnySet"
        variant="ghost"
        size="sm"
        class="h-8 ml-auto text-muted-foreground"
        @click="clear"
      >
        <X class="h-3.5 w-3.5 mr-1" /> Clear
      </Button>
    </div>
  </div>
</template>
