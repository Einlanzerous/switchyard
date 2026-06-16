<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useQuery } from "@tanstack/vue-query";
import {
  Search, X, Bug, CheckSquare2, Lightbulb, Mountain, FolderKanban, User as UserIcon,
} from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { api } from "@/lib/api";
import { queryKeys } from "@/lib/queryKeys";
import { useTicketFilters } from "@/composables/useTicketFilters";
import { useAuthStore } from "@/stores/auth";
import { parseSearchQuery, stringifySearchQuery } from "@/lib/searchDsl";
import ChipGroup from "./ChipGroup.vue";

const { filters, set, toggle, clear, replaceAll, isAnySet } = useTicketFilters();
const auth = useAuthStore();

// ─── data sources ────────────────────────────────────────────────────────────
//
// Used to render meaningful chip labels — the parser keeps raw values
// (project=FLOW, assignee=alice or assignee=<uuid>) and we resolve to
// human-readable names when we have them.
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

// ─── chip enums (status/type/priority remain visual toggles) ─────────────────
const STATUS_OPTIONS = [
  { value: "backlog", label: "Backlog" },
  { value: "planning", label: "Planning" },
  { value: "in_progress", label: "In Progress" },
  { value: "blocked", label: "Blocked" },
  { value: "closed", label: "Closed" },
];
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
const DUE_OPTIONS = [
  { value: "overdue", label: "Overdue" },
  { value: "this_week", label: "Due this week" },
  { value: "none", label: "No due date" },
];

// Due is single-select. ChipGroup is multi by design, so we adapt: render the
// active value as a one-element selected array; clicking the active chip
// clears it, clicking a different chip switches to it.
const dueSelected = computed(() => (filters.value.due ? [filters.value.due] : []));
function toggleDue(value: string) {
  const next = filters.value.due === value ? undefined : (value as "overdue" | "this_week" | "none");
  set("due", next);
}

// ─── input ↔ filter sync ─────────────────────────────────────────────────────
//
// `localText` holds the literal contents of the search input, including any
// `project=`/`assignee=` tokens. We parse it on debounce and propagate to
// the relevant filter slots. When filters change from elsewhere (chip remove,
// clear button, URL nav), we rebuild localText so the visible string stays
// in sync with the active filters.
//
// We do *not* round-trip status/type/priority through the input — those are
// chip-only filters. The DSL parser ignores those keys for the same reason.

const localText = ref("");

// Resolve `assignee=me|@name|<uuid>` → the value the API expects (the user's
// UUID, or the literal "unassigned"). Returns the raw token if we can't map.
function resolveAssignee(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const v = raw.trim();
  if (v.length === 0) return undefined;
  if (v === "unassigned") return "unassigned";
  if (v === "me") return auth.me?.id ?? undefined;
  // @name → match by name (case-insensitive). Plain name also matches.
  const cleaned = v.startsWith("@") ? v.slice(1) : v;
  const byId = users.value.find((u) => u.id === cleaned);
  if (byId) return byId.id;
  const byName = users.value.find((u) => u.name.toLowerCase() === cleaned.toLowerCase());
  if (byName) return byName.id;
  return cleaned;
}

let inputTimer: ReturnType<typeof setTimeout> | null = null;

// User-typed input → parsed query → filter state. Only project/assignee/text
// /customFields are written from the parser so chip-toggled status/type/
// priority stay intact.
function applyParsed() {
  const parsed = parseSearchQuery(localText.value);
  const next = {
    ...filters.value,
    text: parsed.text,
    project: parsed.project,
    assignee: resolveAssignee(parsed.assignee),
    customFields: parsed.customFields,
  };
  // Avoid no-op writes that would still trigger a router.replace.
  if (next.text === filters.value.text
    && JSON.stringify(next.project) === JSON.stringify(filters.value.project)
    && next.assignee === filters.value.assignee
    && JSON.stringify(next.customFields) === JSON.stringify(filters.value.customFields)) return;
  // Single router push. Calling `set` per key here would race: each
  // call reads `filters.value` (a computed off route.query), but
  // router.replace doesn't sync route.query in the same tick — so the
  // 2nd and 3rd calls would spread STALE filters.value and clobber the
  // earlier writes. `replaceAll` writes all keys in one router push.
  replaceAll(next);
}

watch(localText, () => {
  if (inputTimer) clearTimeout(inputTimer);
  inputTimer = setTimeout(applyParsed, 250);
});

// Build the input string from a snapshot of project/assignee/text filters.
// We render assignees by name when we know who they are, otherwise by raw id
// — this keeps the input legible after a hard reload before users load.
function rebuildLocalText() {
  const f = filters.value;
  const assigneeLabel = (() => {
    if (!f.assignee) return undefined;
    if (f.assignee === "unassigned") return "unassigned";
    if (f.assignee === auth.me?.id) return "me";
    const u = users.value.find((x) => x.id === f.assignee);
    return u ? u.name : f.assignee;
  })();
  return stringifySearchQuery({
    text: f.text,
    project: f.project,
    assignee: assigneeLabel,
    customFields: f.customFields,
  });
}

// One-time hydrate from URL on mount.
localText.value = rebuildLocalText();

// Watch filters for changes coming from outside the input (chip remove,
// clear, browser nav). We compare the rebuilt string to localText — if a
// pending parse already produced this state, leave the input alone so we
// don't wipe the user's caret position.
watch(
  () => [filters.value.project, filters.value.assignee, filters.value.text, users.value.length] as const,
  () => {
    const next = rebuildLocalText();
    if (next !== localText.value) localText.value = next;
  }
);

// ─── parsed-token chip removal ───────────────────────────────────────────────

function removeProject(key: string) {
  set("project", filters.value.project.filter((p) => p !== key));
}
function removeAssignee() {
  set("assignee", undefined);
}

// Friendly chip labels.
function projectLabel(key: string): string {
  const p = projects.value.find((x) => x.key === key);
  return p ? `${key} · ${p.name}` : key;
}
function assigneeLabel(idOrSentinel: string): string {
  if (idOrSentinel === "unassigned") return "Unassigned";
  if (idOrSentinel === auth.me?.id) return "Me";
  const u = users.value.find((x) => x.id === idOrSentinel);
  return u ? u.name : idOrSentinel;
}
</script>

<template>
  <div class="border-b bg-background/95 backdrop-blur sticky top-0 z-10">
    <!-- Row 1: search + actions on a single line. The optional `actions` slot
         lets the parent surface context buttons (e.g. "Board view", "New
         ticket") right-aligned. -->
    <div class="px-4 pt-2 flex items-center gap-2">
      <div class="relative flex-1 max-w-2xl">
        <Search class="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          v-model="localText"
          placeholder='Search tickets… try project=FLOW assignee=me "needs review"'
          class="pl-9 bg-muted/50 border-transparent focus-visible:ring-1 h-8"
        />
      </div>
      <div class="ml-auto flex items-center gap-2">
        <slot name="actions" />
      </div>
    </div>

    <!-- Parsed-token chips: only render when there's at least one to show.
         Status/type/priority chip groups live in the next row regardless. -->
    <div
      v-if="filters.project.length > 0 || filters.assignee"
      class="px-4 pt-2 flex flex-wrap items-center gap-1.5"
    >
      <Badge
        v-for="key in filters.project"
        :key="`proj-${key}`"
        variant="secondary"
        class="gap-1 pl-1.5 pr-1 py-0.5"
      >
        <FolderKanban class="h-3 w-3 text-muted-foreground" />
        <span class="font-mono text-[11px]">{{ projectLabel(key) }}</span>
        <button
          type="button"
          class="ml-0.5 rounded p-0.5 hover:bg-background/60"
          aria-label="Remove project filter"
          @click="removeProject(key)"
        >
          <X class="h-3 w-3" />
        </button>
      </Badge>

      <Badge
        v-if="filters.assignee"
        variant="secondary"
        class="gap-1 pl-1.5 pr-1 py-0.5"
      >
        <UserIcon class="h-3 w-3 text-muted-foreground" />
        <span class="text-[11px]">{{ assigneeLabel(filters.assignee) }}</span>
        <button
          type="button"
          class="ml-0.5 rounded p-0.5 hover:bg-background/60"
          aria-label="Remove assignee filter"
          @click="removeAssignee"
        >
          <X class="h-3 w-3" />
        </button>
      </Badge>
    </div>

    <!-- Row 2: status / type / priority chip groups + Clear pinned right.
         `min-h-12` reserves the full height of the (taller, h-8) Clear button
         so the row doesn't grow by 8px the instant a filter is selected and
         `isAnySet` flips the button into existence — toggling filters used to
         bounce the whole list. -->
    <div class="px-4 py-2 flex flex-wrap items-center gap-x-4 gap-y-2 min-h-12">
      <ChipGroup label="Status" :options="STATUS_OPTIONS" :selected="filters.status"
                 @toggle="(v) => toggle('status', v)" />
      <ChipGroup label="Type" :options="TYPE_OPTIONS" :selected="filters.type"
                 @toggle="(v) => toggle('type', v)" />
      <ChipGroup label="Priority" :options="PRIORITY_OPTIONS" :selected="filters.priority"
                 @toggle="(v) => toggle('priority', v)" />
      <ChipGroup label="Due" :options="DUE_OPTIONS" :selected="dueSelected" @toggle="toggleDue" />

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
