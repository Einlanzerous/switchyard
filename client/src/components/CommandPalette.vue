<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useQuery } from "@tanstack/vue-query";
import {
  Inbox, KanbanSquare, FolderKanban, Plus, Settings, Zap, ArrowRight, Bookmark,
} from "lucide-vue-next";
import {
  CommandDialog, CommandEmpty, CommandGroup, CommandInput,
  CommandItem, CommandList, CommandSeparator,
} from "@/components/ui/command";
import { api } from "@/lib/api";
import { queryKeys } from "@/lib/queryKeys";
import { useUiStore } from "@/stores/ui";
import { useSavedViewsList } from "@/composables/useSavedViews";
import { useTicketFilters } from "@/composables/useTicketFilters";
import TypeIcon from "@/components/tickets/TypeIcon.vue";
import type { SavedView } from "@switchyard/shared";

const ui = useUiStore();
const router = useRouter();
const route = useRoute();
const { replaceAll } = useTicketFilters();

const open = computed({
  get: () => ui.paletteOpen,
  set: (v) => v ? ui.openPalette() : ui.closePalette(),
});

const query = ref("");

// Reset the input each time the palette opens — the user expects a fresh
// search target, not whatever they typed last time.
watch(() => ui.paletteOpen, (v) => { if (v) query.value = ""; });

// Quick path: typing exactly a ticket key (FLOW-1, SWY-47) lets us short-cut
// straight to that ticket without paying for a text-search round trip.
const KEY_RE = /^[A-Z][A-Z0-9]{1,9}-[1-9][0-9]*$/;
const upperQuery = computed(() => query.value.trim().toUpperCase());
const looksLikeKey = computed(() => KEY_RE.test(upperQuery.value));

// Tickets text search. Disabled until the user has typed something
// substantive — empty palette shows actions + project/board lists only.
const ticketsQuery = useQuery({
  queryKey: computed(() => ["sw", "command-palette", "tickets", query.value]),
  enabled: computed(() =>
    ui.paletteOpen
    && query.value.trim().length >= 2
    && !looksLikeKey.value,
  ),
  staleTime: 10_000,
  queryFn: async () => {
    const { data, error } = await api.GET("/v1/tickets", {
      params: { query: { text: query.value.trim(), limit: 8 } },
    });
    if (error) throw error;
    return data;
  },
});

// Use the same canonical keys as ProjectMultiSelect / useBoardsList so the
// palette piggybacks on the cache instead of triggering a new fetch on first
// open. Limits match the existing callers (200 / 200) for cache compatibility.
const projectsQuery = useQuery({
  queryKey: queryKeys.projects(),
  enabled: computed(() => ui.paletteOpen),
  staleTime: 5 * 60 * 1000,
  queryFn: async () => {
    const { data, error } = await api.GET("/v1/projects", { params: { query: { limit: 200 } } });
    if (error) throw error;
    return data;
  },
});

const boardsQuery = useQuery({
  queryKey: queryKeys.boards(),
  enabled: computed(() => ui.paletteOpen),
  staleTime: 5 * 60 * 1000,
  queryFn: async () => {
    const { data, error } = await api.GET("/v1/boards", { params: { query: { limit: 200 } } });
    if (error) throw error;
    return data;
  },
});

// Filter projects / boards client-side by the current query so the
// CommandList still feels live without per-keystroke API hits.
function fuzzy(haystack: string, needle: string): boolean {
  if (!needle) return true;
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

const filteredProjects = computed(() => {
  const all = projectsQuery.data.value?.items ?? [];
  const q = query.value.trim();
  return all.filter((p) => fuzzy(p.key, q) || fuzzy(p.name, q)).slice(0, 6);
});

const filteredBoards = computed(() => {
  const all = boardsQuery.data.value?.items ?? [];
  const q = query.value.trim();
  return all.filter((b) => fuzzy(b.name, q)).slice(0, 6);
});

const tickets = computed(() => ticketsQuery.data.value?.items ?? []);

// Saved views — fetched once when the palette opens. We surface them in
// their own group so power users can hop between filter combinations
// without leaving the keyboard.
const savedViewsQuery = useSavedViewsList();
const filteredSavedViews = computed(() => {
  const all = (savedViewsQuery.data.value?.items ?? []) as SavedView[];
  const q = query.value.trim();
  return all.filter((v) => fuzzy(v.name, q)).slice(0, 8);
});

function applySavedView(v: SavedView) {
  ui.closePalette();
  // Make sure we're on /tickets so the URL filters take effect on the list.
  if (!route.path.startsWith("/tickets")) {
    router.push("/tickets").then(() => {
      replaceAll({
        project: v.filters.project ?? [],
        status: v.filters.status ?? [],
        type: v.filters.type ?? [],
        priority: v.filters.priority ?? [],
        assignee: v.filters.assignee ?? undefined,
        text: v.filters.text ?? undefined,
        due: v.filters.due ?? undefined,
      });
    });
    return;
  }
  replaceAll({
    project: v.filters.project ?? [],
    status: v.filters.status ?? [],
    type: v.filters.type ?? [],
    priority: v.filters.priority ?? [],
    assignee: v.filters.assignee ?? undefined,
    text: v.filters.text ?? undefined,
    due: v.filters.due ?? undefined,
  });
}

// ─── actions ────────────────────────────────────────────────────────────────

function go(path: string) {
  ui.closePalette();
  router.push(path);
}
function jumpToKey(key: string) {
  ui.closePalette();
  router.push(`/tickets/${key}`);
}
function newTicket() {
  ui.closePalette();
  ui.openCreateTicket();
}
</script>

<template>
  <!-- Command's filter is client-side substring matching; we feed it our own
       pre-filtered lists. value="x" forces "always show" so radix doesn't
       drop our items behind its own substring filter when the query is
       slightly off (we already did the matching). -->
  <CommandDialog v-model:open="open">
    <CommandInput
      v-model="query"
      placeholder="Search tickets, projects, boards…  type a ticket key (e.g. FLOW-1) to jump"
    />
    <CommandList>
      <!-- Direct-jump for ticket keys — skips even hitting the API. -->
      <CommandGroup v-if="looksLikeKey" heading="Jump to">
        <CommandItem :value="`jump-${upperQuery}`" @select="jumpToKey(upperQuery)">
          <ArrowRight class="h-4 w-4 mr-2 text-muted-foreground" />
          Open <span class="font-mono ml-1">{{ upperQuery }}</span>
        </CommandItem>
      </CommandGroup>

      <CommandGroup heading="Actions">
        <CommandItem value="new-ticket" @select="newTicket">
          <Plus class="h-4 w-4 mr-2 text-muted-foreground" />
          New ticket
          <span class="ml-auto text-[10px] text-muted-foreground font-mono">c</span>
        </CommandItem>
      </CommandGroup>

      <CommandGroup v-if="!looksLikeKey && tickets.length > 0" heading="Tickets">
        <CommandItem
          v-for="t in tickets"
          :key="t.id"
          :value="`ticket-${t.id}`"
          @select="jumpToKey(t.key)"
        >
          <TypeIcon :type="t.type" class="h-4 w-4 mr-2" />
          <span class="font-mono text-xs text-muted-foreground mr-2">{{ t.key }}</span>
          <span class="truncate">{{ t.title }}</span>
        </CommandItem>
      </CommandGroup>

      <CommandGroup v-if="filteredProjects.length > 0" heading="Projects">
        <CommandItem
          v-for="p in filteredProjects"
          :key="p.id"
          :value="`project-${p.id}`"
          @select="go(`/projects/${p.key}/board`)"
        >
          <FolderKanban class="h-4 w-4 mr-2 text-muted-foreground" />
          <span class="font-mono text-xs text-muted-foreground mr-2">{{ p.key }}</span>
          <span class="truncate">{{ p.name }}</span>
          <span class="ml-auto text-[10px] text-muted-foreground">board</span>
        </CommandItem>
      </CommandGroup>

      <CommandGroup v-if="filteredBoards.length > 0" heading="Boards">
        <CommandItem
          v-for="b in filteredBoards"
          :key="b.id"
          :value="`board-${b.id}`"
          @select="go(`/boards/${b.id}`)"
        >
          <KanbanSquare class="h-4 w-4 mr-2 text-muted-foreground" />
          <span class="truncate">{{ b.name }}</span>
        </CommandItem>
      </CommandGroup>

      <CommandGroup v-if="filteredSavedViews.length > 0" heading="Saved views">
        <CommandItem
          v-for="v in filteredSavedViews"
          :key="v.id"
          :value="`view-${v.id}`"
          @select="applySavedView(v)"
        >
          <Bookmark class="h-4 w-4 mr-2 text-muted-foreground" />
          <span class="truncate flex-1">{{ v.name }}</span>
          <span class="ml-2 text-[10px] text-muted-foreground shrink-0">
            {{ v.scope === "shared" ? `shared · ${v.owner.name}` : "personal" }}
          </span>
        </CommandItem>
      </CommandGroup>

      <CommandSeparator />

      <CommandGroup heading="Navigation">
        <CommandItem value="nav-tickets" @select="go('/tickets')">
          <Inbox class="h-4 w-4 mr-2 text-muted-foreground" />
          Tickets
          <span class="ml-auto text-[10px] text-muted-foreground font-mono">g t</span>
        </CommandItem>
        <CommandItem value="nav-boards" @select="go('/boards')">
          <KanbanSquare class="h-4 w-4 mr-2 text-muted-foreground" />
          Boards
          <span class="ml-auto text-[10px] text-muted-foreground font-mono">g b</span>
        </CommandItem>
        <CommandItem value="nav-automations" @select="go('/automations')">
          <Zap class="h-4 w-4 mr-2 text-muted-foreground" />
          Automations
          <span class="ml-auto text-[10px] text-muted-foreground font-mono">g a</span>
        </CommandItem>
        <CommandItem value="nav-settings" @select="go('/settings')">
          <Settings class="h-4 w-4 mr-2 text-muted-foreground" />
          Settings
          <span class="ml-auto text-[10px] text-muted-foreground font-mono">g s</span>
        </CommandItem>
      </CommandGroup>

      <CommandEmpty>No results for "{{ query }}".</CommandEmpty>
    </CommandList>
  </CommandDialog>
</template>
