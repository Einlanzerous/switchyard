<script setup lang="ts">
import { computed, ref } from "vue";
import { useRouter } from "vue-router";
import { useQuery } from "@tanstack/vue-query";
import {
  Plus, Search, FolderKanban, Archive, ChevronRight,
  LayoutGrid, List as ListIcon, Eye, EyeOff,
} from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip, TooltipContent, TooltipProvider, TooltipTrigger,
} from "@/components/ui/tooltip";
import { api } from "@/lib/api";
import { queryKeys } from "@/lib/queryKeys";
import { useProjectsStats } from "@/composables/useProjectStats";
import CreateProjectDialog from "@/components/projects/CreateProjectDialog.vue";
import { useAuthStore } from "@/stores/auth";

const router = useRouter();
const auth = useAuthStore();
// Project creation is an instance-admin surface (owner / agent) — a member,
// even a project admin, can't mint projects. Hide the CTA for non-owners (6.5).
const canCreateProject = computed(() => auth.isOwner);

// Layout + filter prefs persist across reloads. Kept in localStorage rather
// than the URL so the view feels stable as a "home" rather than a query.
const LAYOUT_KEY = "sw.projects.layout";
const ARCHIVED_KEY = "sw.projects.showArchived";

type Layout = "list" | "grid";
const layout = ref<Layout>(
  (localStorage.getItem(LAYOUT_KEY) as Layout | null) ?? "list"
);
function setLayout(l: Layout) {
  layout.value = l;
  localStorage.setItem(LAYOUT_KEY, l);
}

const showArchived = ref(localStorage.getItem(ARCHIVED_KEY) === "1");
function toggleArchived() {
  showArchived.value = !showArchived.value;
  localStorage.setItem(ARCHIVED_KEY, showArchived.value ? "1" : "0");
}

const search = ref("");
const showCreate = ref(false);

// Pull everything in one shot — we always want the archived rows in cache so
// the toggle is instant. Filtering is client-side.
const projectsQuery = useQuery({
  queryKey: queryKeys.projects({ include_archived: true }),
  staleTime: 60 * 1000,
  queryFn: async () => {
    const { data, error } = await api.GET("/v1/projects", {
      params: { query: { limit: 200, include_archived: true } },
    });
    if (error) throw error;
    return data;
  },
});
const allProjects = computed(() => projectsQuery.data.value?.items ?? []);

// Counts come from the bulk stats endpoint. Pre-indexed so each row's lookup
// is O(1) without recomputing per render.
const statsQuery = useProjectsStats();
const countsByProjectId = computed(() => {
  const map = new Map<string, { open: number; closed: number; total: number }>();
  for (const r of statsQuery.data.value?.items ?? []) {
    map.set(r.project.id, r.totals);
  }
  return map;
});
function counts(id: string): { open: number; closed: number; total: number } {
  return countsByProjectId.value.get(id) ?? { open: 0, closed: 0, total: 0 };
}

const visible = computed(() => {
  const q = search.value.trim().toLowerCase();
  return allProjects.value
    .filter((p) => showArchived.value ? true : !p.archived_at)
    .filter((p) => !q
      || p.key.toLowerCase().includes(q)
      || p.name.toLowerCase().includes(q)
      || (p.description ?? "").toLowerCase().includes(q));
});

const archivedCount = computed(() =>
  allProjects.value.filter((p) => !!p.archived_at).length
);

// Reserve a fixed-character-width gutter for the project key column so 3-char
// keys (SWY) line up flush with 4-char keys (APTR). Monospace + `ch` units
// makes this exact. Reactive to whichever projects are currently visible —
// will widen automatically if a longer key appears later (schema max 10).
const maxKeyLen = computed(() => {
  const lens = visible.value.map((p) => p.key.length);
  return lens.length === 0 ? 3 : Math.max(...lens);
});

function open(key: string) {
  router.push(`/projects/${key}/board`);
}

function onCreated(p: { key: string }) {
  // Drop the user straight into the new project's board so they can start
  // setting up statuses. Same flow as creating from /settings/projects.
  router.push(`/projects/${p.key}/board`);
}
</script>

<template>
  <div class="px-6 py-5 max-w-6xl mx-auto space-y-5">
    <header class="flex items-end justify-between gap-3">
      <div>
        <h1 class="text-2xl font-semibold tracking-tight">Projects</h1>
        <p class="text-sm text-muted-foreground mt-1">
          Each project owns its own statuses, transitions, and ticket numbering.
        </p>
      </div>
      <Button v-if="canCreateProject" size="sm" @click="showCreate = true">
        <Plus class="h-3.5 w-3.5 mr-1.5" /> New project
      </Button>
    </header>

    <!-- Toolbar -->
    <div class="flex items-center gap-2">
      <div class="relative flex-1 max-w-md">
        <Search class="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          v-model="search"
          placeholder="Search projects…"
          class="pl-9 h-8 bg-muted/50 border-transparent focus-visible:ring-1"
        />
      </div>

      <div class="ml-auto flex items-center gap-1">
        <TooltipProvider :delay-duration="200">
          <Tooltip>
            <TooltipTrigger as-child>
              <Button
                variant="ghost"
                size="sm"
                class="h-8 px-2"
                :aria-pressed="showArchived"
                @click="toggleArchived"
              >
                <component :is="showArchived ? Eye : EyeOff" class="h-3.5 w-3.5 mr-1.5" />
                {{ showArchived ? "Showing archived" : "Hiding archived" }}
                <span v-if="archivedCount > 0" class="ml-1.5 text-[10px] text-muted-foreground">
                  ({{ archivedCount }})
                </span>
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {{ showArchived ? "Click to hide archived projects" : "Click to show archived projects" }}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>

        <!-- Layout toggle. Two buttons reading like a segmented control. -->
        <div class="ml-2 flex items-center rounded-md border p-0.5">
          <Button
            variant="ghost"
            size="sm"
            class="h-7 px-2"
            :class="layout === 'list' ? 'bg-accent text-foreground' : 'text-muted-foreground'"
            aria-label="List view"
            @click="setLayout('list')"
          >
            <ListIcon class="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            class="h-7 px-2"
            :class="layout === 'grid' ? 'bg-accent text-foreground' : 'text-muted-foreground'"
            aria-label="Grid view"
            @click="setLayout('grid')"
          >
            <LayoutGrid class="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
    </div>

    <!-- Loading skeletons. Match the active layout so the swap is jitter-free. -->
    <div v-if="projectsQuery.isLoading.value">
      <div v-if="layout === 'list'" class="space-y-2">
        <Skeleton v-for="n in 6" :key="n" class="h-12 w-full" />
      </div>
      <div v-else class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        <Skeleton v-for="n in 6" :key="n" class="h-28 w-full" />
      </div>
    </div>

    <!-- Empty -->
    <div
      v-else-if="visible.length === 0"
      class="flex flex-col items-center justify-center text-center p-10 border rounded-lg bg-muted/20"
    >
      <FolderKanban class="h-10 w-10 text-muted-foreground/40 mb-3" />
      <h3 class="text-sm font-medium">
        {{ allProjects.length === 0 ? "No projects yet" : "No projects match" }}
      </h3>
      <p class="text-xs text-muted-foreground mt-1">
        {{ allProjects.length === 0
          ? "Create your first project to start tracking work."
          : "Try a different search or toggle archived projects." }}
      </p>
      <Button
        v-if="allProjects.length === 0 && canCreateProject"
        size="sm"
        class="mt-3"
        @click="showCreate = true"
      >
        <Plus class="h-3.5 w-3.5 mr-1.5" /> New project
      </Button>
    </div>

    <!-- LIST -->
    <Card v-else-if="layout === 'list'">
      <CardContent class="p-0">
        <ul class="divide-y">
          <li
            v-for="p in visible"
            :key="p.id"
            class="flex items-center gap-3 p-3 cursor-pointer hover:bg-accent/40 transition-colors"
            @click="open(p.key)"
          >
            <FolderKanban
              class="h-4 w-4 shrink-0"
              :class="p.color ? '' : 'text-muted-foreground'"
              :style="p.color ? { color: p.color } : undefined"
            />
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-2">
                <span
                  class="font-mono text-xs text-muted-foreground shrink-0"
                  :style="{ minWidth: `${maxKeyLen}ch` }"
                >{{ p.key }}</span>
                <span class="font-medium truncate">{{ p.name }}</span>
                <Badge v-if="p.archived_at" variant="secondary" class="text-[10px]">
                  <Archive class="h-2.5 w-2.5 mr-0.5" /> archived
                </Badge>
              </div>
              <div v-if="p.description" class="text-xs text-muted-foreground truncate mt-0.5">
                {{ p.description }}
              </div>
            </div>
            <div class="text-xs text-muted-foreground tabular-nums shrink-0 hidden sm:flex items-center gap-3">
              <span><span class="font-medium text-foreground">{{ counts(p.id).open }}</span> open</span>
              <span class="text-muted-foreground/60">/ {{ counts(p.id).total }}</span>
            </div>
            <ChevronRight class="h-4 w-4 text-muted-foreground shrink-0" />
          </li>
        </ul>
      </CardContent>
    </Card>

    <!-- GRID -->
    <div v-else class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
      <button
        v-for="p in visible"
        :key="p.id"
        type="button"
        class="text-left rounded-lg border bg-card p-4 hover:bg-accent/40 hover:border-accent transition-colors flex flex-col gap-2 h-[150px]"
        @click="open(p.key)"
      >
        <div class="flex items-center gap-2 min-w-0">
          <FolderKanban
            class="h-4 w-4 shrink-0"
            :class="p.color ? '' : 'text-muted-foreground'"
            :style="p.color ? { color: p.color } : undefined"
          />
          <span
            class="font-mono text-xs text-muted-foreground shrink-0"
            :style="{ minWidth: `${maxKeyLen}ch` }"
          >{{ p.key }}</span>
          <Badge v-if="p.archived_at" variant="secondary" class="text-[10px] ml-auto">
            <Archive class="h-2.5 w-2.5 mr-0.5" /> archived
          </Badge>
        </div>
        <div class="font-medium truncate">{{ p.name }}</div>
        <p v-if="p.description" class="text-xs text-muted-foreground line-clamp-2 flex-1">
          {{ p.description }}
        </p>
        <div class="mt-auto pt-1 text-xs text-muted-foreground tabular-nums flex items-center gap-3">
          <span><span class="font-medium text-foreground">{{ counts(p.id).open }}</span> open</span>
          <span class="text-muted-foreground/60">/ {{ counts(p.id).total }}</span>
        </div>
      </button>
    </div>

    <CreateProjectDialog v-model:open="showCreate" @created="onCreated" />
  </div>
</template>
