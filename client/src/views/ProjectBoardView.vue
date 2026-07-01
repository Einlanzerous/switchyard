<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useMutation, useQueryClient } from "@tanstack/vue-query";
import { ArrowLeft, List, Loader2, AlertCircle, Inbox, Plus } from "lucide-vue-next";
import { toast } from "vue-sonner";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import BoardColumn from "@/components/tickets/BoardColumn.vue";
import InsightsTabs from "@/components/dashboard/InsightsTabs.vue";
import ProjectHeaderLabel from "@/components/projects/ProjectHeaderLabel.vue";
import ReadOnlyBanner from "@/components/projects/ReadOnlyBanner.vue";
import SortMenu from "@/components/tickets/SortMenu.vue";
import { useProjectPermissions } from "@/composables/useProjectPermissions";
import { providePlanReviewIndex } from "@/composables/usePlanReviewIndex";
import { api } from "@/lib/api";
import { queryKeys } from "@/lib/queryKeys";
import { useUiStore } from "@/stores/ui";
import { useProjectBoard, type BoardColumn as Col } from "@/composables/useProjectBoard";
import { SORT_MODES, type SortMode } from "@/lib/positions";

const ui = useUiStore();
import type { Resolution, TicketSummary } from "@switchyard/shared";

const route = useRoute();
const router = useRouter();
const qc = useQueryClient();

const projectKey = computed(() => {
  const v = route.params.key;
  return typeof v === "string" ? v : null;
});

// Provide the "plan in review" ticket-id set to the cards (7.1 board badge).
providePlanReviewIndex();

// Board view toggle: hide epics by default (they rarely move column-to-
// column and add visual noise). `?epics=1` opts in. Persisted via URL so
// refresh/share carries it.
const showEpics = computed(() => route.query.epics === "1");
function setShowEpics(next: boolean) {
  const q = { ...route.query };
  if (next) q.epics = "1";
  else delete q.epics;
  router.replace({ query: q });
}

// Sort mode also rides the URL. Default `smart` keeps the board looking
// identical to today when nobody has due dates set; once dates exist, those
// cards float to the top of each column.
const VALID_MODES = new Set(SORT_MODES.map((m) => m.value));
const sortMode = computed<SortMode>(() => {
  const v = route.query.sort;
  return typeof v === "string" && VALID_MODES.has(v as SortMode) ? (v as SortMode) : "smart";
});
function setSortMode(next: SortMode) {
  const q = { ...route.query };
  if (next === "smart") delete q.sort;
  else q.sort = next;
  router.replace({ query: q });
}

const { project, columns, isLoading, error, refetch, closedWindowDays } = useProjectBoard(projectKey, showEpics, sortMode);

// Hide the New-ticket CTA + show a banner when the user is a viewer on this
// project (6.5/6.6). Drag-to-transition is gated server-side regardless.
const { canWrite, isReadOnly } = useProjectPermissions(projectKey);

// ─── drop → transition wiring ────────────────────────────────────────────────

// Tracks which ticket is mid-drop so cards can dim during the operation.
const inflightTicketId = ref<string | null>(null);

type TicketsResponse = { items: TicketSummary[]; page: { next_cursor: string | null; has_more: boolean } };

// `mode` lets us re-use the same mutation for both same-column reorder
// (PATCH only) and cross-column transition (POST /transition with optional
// position).
const transitionMutation = useMutation({
  mutationFn: async (input: {
    ticketId: string;
    toStatusId: string;
    position?: number;
    resolution?: Resolution;
    // True = same-column reorder, only mutate position via PATCH.
    reorderOnly?: boolean;
  }) => {
    if (input.reorderOnly) {
      const { data, error: apiError } = await api.PATCH("/v1/tickets/{idOrKey}", {
        params: { path: { idOrKey: input.ticketId } },
        body: { position: input.position },
      });
      if (apiError) throw apiError;
      return data;
    }
    const { data, error: apiError } = await api.POST("/v1/tickets/{idOrKey}/transition", {
      params: { path: { idOrKey: input.ticketId } },
      body: {
        status_id: input.toStatusId,
        resolution: input.resolution,
        position: input.position,
      },
    });
    if (apiError) throw apiError;
    return data;
  },
  // Optimistic: snapshot current cache, mutate the affected ticket's status
  // and/or position so the UI re-renders immediately. Roll back if the API rejects.
  onMutate: async (input) => {
    inflightTicketId.value = input.ticketId;

    if (!projectKey.value) return;
    const key = queryKeys.projectBoard(projectKey.value);
    await qc.cancelQueries({ queryKey: key });
    const previous = qc.getQueryData<TicketsResponse>(key);
    if (!previous) return { previous };

    const targetCol = columns.value.find((c) => c.dropTargetStatusId === input.toStatusId);
    if (!targetCol) return { previous };

    const next: TicketsResponse = {
      ...previous,
      items: previous.items.map((t) => {
        if (t.id !== input.ticketId) return t;
        if (input.reorderOnly) {
          return {
            ...t,
            position: input.position ?? t.position,
            updated_at: new Date().toISOString(),
          };
        }
        return {
          ...t,
          status: {
            id: input.toStatusId,
            category: targetCol.category,
            display_name: targetCol.displayName,
          },
          resolution: input.resolution ?? null,
          position: input.position ?? t.position,
          updated_at: new Date().toISOString(),
        };
      }),
    };
    qc.setQueryData(key, next);
    return { previous };
  },
  onError: (err, _vars, ctx) => {
    if (projectKey.value && ctx?.previous) {
      qc.setQueryData(queryKeys.projectBoard(projectKey.value), ctx.previous);
    }
    const msg = (err as { error?: { message?: string } }).error?.message ?? "Transition failed";
    toast.error(msg);
  },
  onSettled: () => {
    inflightTicketId.value = null;
    if (projectKey.value) {
      qc.invalidateQueries({ queryKey: queryKeys.projectBoard(projectKey.value) });
    }
    qc.invalidateQueries({ queryKey: ["sw", "tickets"] });
  },
});

function handleDrop(payload: {
  ticketId: string;
  fromCategory: Col["category"];
  toCategory: Col["category"];
  toStatusId: string;
  position: number;
}) {
  // Same-column drop ⇒ pure reorder, no status mutation.
  if (payload.fromCategory === payload.toCategory) {
    transitionMutation.mutate({
      ticketId: payload.ticketId,
      toStatusId: payload.toStatusId,
      position: payload.position,
      reorderOnly: true,
    });
    return;
  }
  // Drag-to-closed auto-uses `done` — that's the overwhelming common case
  // and prompting every time is friction. To pick `released` or `cancelled`
  // instead, edit the resolution from the drawer after the fact, or use
  // the bulk transition modal where batch-resolution is the explicit point.
  transitionMutation.mutate({
    ticketId: payload.ticketId,
    toStatusId: payload.toStatusId,
    position: payload.position,
    resolution: payload.toCategory === "closed" ? "done" : undefined,
  });
}

// ─── ticket open (drawer) ────────────────────────────────────────────────────

function openTicket(key: string) {
  router.push({ query: { ...route.query, focus: key } });
}

// ─── keyboard nav (3.4 C) ───────────────────────────────────────────────────
//
// Two-axis movement on the board:
//   ←/→  switch columns (skipping any that are empty after a wraparound
//        check — we still let the user park on an empty column so they
//        can press `c` to create into it; arrow nav ignores them only
//        when there are no cards at all to focus).
//   ↑/↓  move within the current column.
//   Enter  open the focused card in the drawer.
//   Esc    drop keyboard focus (does not close the drawer if open).
//
// Position is tracked as (columnIndex, ticketIndex) into the live
// `columns` array. When the underlying data changes (drag-and-drop, an
// agent moves a card, etc.), we clamp the indices back into range.

const focusedColIdx = ref<number>(-1);
const focusedTicketIdx = ref<number>(0);

function isTypingTarget(t: EventTarget | null): boolean {
  if (!t || !(t instanceof HTMLElement)) return false;
  if (t.isContentEditable) return true;
  const tag = t.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

const focusedTicketId = computed<string | null>(() => {
  const c = columns.value[focusedColIdx.value];
  if (!c) return null;
  return c.tickets[focusedTicketIdx.value]?.id ?? null;
});

function moveColumn(delta: number) {
  const total = columns.value.length;
  if (total === 0) return;
  let next = focusedColIdx.value === -1
    ? (delta > 0 ? 0 : total - 1)
    : Math.max(0, Math.min(total - 1, focusedColIdx.value + delta));
  focusedColIdx.value = next;
  // Clamp the ticket index to the new column's length.
  const len = columns.value[next]?.tickets.length ?? 0;
  focusedTicketIdx.value = Math.max(0, Math.min(len - 1, focusedTicketIdx.value));
}

function moveTicket(delta: number) {
  if (focusedColIdx.value === -1) {
    // Pressing up/down with no column focused → park on the first
    // non-empty column.
    const firstWithTickets = columns.value.findIndex((c) => c.tickets.length > 0);
    if (firstWithTickets === -1) return;
    focusedColIdx.value = firstWithTickets;
    focusedTicketIdx.value = 0;
    return;
  }
  const col = columns.value[focusedColIdx.value];
  if (!col || col.tickets.length === 0) return;
  focusedTicketIdx.value = Math.max(0, Math.min(col.tickets.length - 1, focusedTicketIdx.value + delta));
}

function onBoardKeydown(e: KeyboardEvent) {
  if (isTypingTarget(e.target)) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;

  switch (e.key) {
    case "ArrowLeft":
      e.preventDefault();
      moveColumn(-1);
      return;
    case "ArrowRight":
      e.preventDefault();
      moveColumn(1);
      return;
    case "ArrowUp":
    case "k":
      e.preventDefault();
      moveTicket(-1);
      return;
    case "ArrowDown":
    case "j":
      e.preventDefault();
      moveTicket(1);
      return;
    case "Enter": {
      const id = focusedTicketId.value;
      if (!id) return;
      const t = columns.value[focusedColIdx.value]?.tickets[focusedTicketIdx.value];
      if (!t) return;
      e.preventDefault();
      openTicket(t.key);
      return;
    }
    case "Escape":
      // Don't fight the drawer's own Esc when it's open.
      if (route.query.focus) return;
      if (focusedColIdx.value !== -1) {
        e.preventDefault();
        focusedColIdx.value = -1;
      }
      return;
  }
}

onMounted(() => window.addEventListener("keydown", onBoardKeydown));
onBeforeUnmount(() => window.removeEventListener("keydown", onBoardKeydown));

// Re-clamp the focused position when the underlying columns shape changes
// (status added/removed, ticket dragged elsewhere, etc.).
watch(columns, (cols) => {
  if (focusedColIdx.value >= cols.length) {
    focusedColIdx.value = -1;
    return;
  }
  const len = cols[focusedColIdx.value]?.tickets.length ?? 0;
  focusedTicketIdx.value = Math.max(0, Math.min(len - 1, focusedTicketIdx.value));
});

// ─── nav back to list ────────────────────────────────────────────────────────

function viewAsList() {
  if (!projectKey.value) return;
  router.push({ path: "/tickets", query: { project: projectKey.value } });
}

function backToProjects() {
  router.push("/projects");
}

const errMessage = computed(() => {
  const e = error.value;
  if (!e) return null;
  return (e as { error?: { message?: string } }).error?.message ?? "Failed to load board";
});
</script>

<template>
  <div class="flex flex-col h-full">
    <!-- Header. Single row: back · | · KEY — name · | · tabs · (filler) · controls.
         Back returns to /projects (the directory); the Board/Insights tabs
         swap the body within this same shell so the surrounding chrome
         doesn't shift on tab change.
         Tabs' underline overlaps the wrapper border-b via `-mb-[2px]`, so
         we keep the wrapper's border-b and skip vertical padding on the
         row — every child sits flush with the bottom border. -->
    <div class="border-b bg-background/95 backdrop-blur sticky top-0 z-10">
      <div class="px-4 h-12 flex items-center gap-2">
        <Button variant="ghost" size="sm" class="h-8 -ml-2" @click="backToProjects">
          <ArrowLeft class="h-3.5 w-3.5 mr-1" /> Back
        </Button>
        <Separator orientation="vertical" class="h-5" />
        <ProjectHeaderLabel :project-key="projectKey" :project="project" />
        <Separator orientation="vertical" class="h-5" />
        <InsightsTabs
          :board-path="`/projects/${projectKey}/board`"
          :insights-path="`/projects/${projectKey}/insights`"
          :setup-path="`/projects/${projectKey}/setup`"
        />
        <div class="flex-1 min-w-0" />
        <label
          class="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer select-none"
          title="Epics rarely move column-to-column; hidden by default to keep the board focused on actionable work."
        >
          <Switch
            class="scale-90"
            :model-value="showEpics"
            @update:model-value="setShowEpics"
          />
          Show epics
        </label>
        <SortMenu
          :model-value="sortMode"
          :options="SORT_MODES"
          label="Sort"
          @update:model-value="setSortMode"
        />
        <Button variant="outline" size="sm" class="h-8" @click="viewAsList">
          <List class="h-3.5 w-3.5 mr-1.5" /> List
        </Button>
        <Button v-if="canWrite" size="sm" class="h-8" @click="ui.openCreateTicket(projectKey)">
          <Plus class="h-3.5 w-3.5 mr-1.5" /> New ticket
        </Button>
        <Loader2
          v-if="transitionMutation.isPending.value"
          class="h-4 w-4 text-muted-foreground animate-spin"
        />
      </div>
    </div>

    <ReadOnlyBanner v-if="isReadOnly" />

    <!-- Loading -->
    <div v-if="isLoading" class="flex-1 p-4 flex gap-3 overflow-x-auto">
      <Skeleton v-for="n in 4" :key="n" class="h-96 w-72 shrink-0 rounded-lg" />
    </div>

    <!-- Error -->
    <div v-else-if="errMessage" class="flex-1 flex flex-col items-center justify-center text-center p-10">
      <AlertCircle class="h-8 w-8 text-destructive mb-2" />
      <p class="text-sm text-destructive">{{ errMessage }}</p>
      <Button variant="outline" size="sm" class="mt-3" @click="refetch">Retry</Button>
    </div>

    <!-- Empty (no statuses) -->
    <div
      v-else-if="columns.length === 0"
      class="flex-1 flex flex-col items-center justify-center text-center p-10"
    >
      <Inbox class="h-10 w-10 text-muted-foreground/40 mb-3" />
      <h3 class="text-sm font-medium">This project has no statuses.</h3>
      <p class="text-xs text-muted-foreground mt-1">
        Configure statuses for {{ projectKey }} before using the board.
      </p>
    </div>

    <!-- Columns -->
    <div v-else class="flex-1 overflow-x-auto p-4">
      <div class="flex gap-3 h-full">
        <BoardColumn
          v-for="(col, idx) in columns"
          :key="col.category"
          :column="col"
          :dragging-ticket-id="inflightTicketId"
          :focused-ticket-id="idx === focusedColIdx ? focusedTicketId : null"
          :hint="col.category === 'closed' ? `last ${closedWindowDays} days` : undefined"
          @open="openTicket"
          @drop="handleDrop"
        />
      </div>
    </div>

  </div>
</template>
