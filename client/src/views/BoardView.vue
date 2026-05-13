<script setup lang="ts">
import { computed, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useMutation, useQueryClient } from "@tanstack/vue-query";
import { ArrowLeft, AlertCircle, Inbox, Loader2, Pencil, Plus } from "lucide-vue-next";
import { toast } from "vue-sonner";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import BoardCell from "@/components/boards/BoardCell.vue";
import SwimlaneSelector, { type SwimlaneBy } from "@/components/boards/SwimlaneSelector.vue";
import EditBoardDialog from "@/components/boards/EditBoardDialog.vue";
import InsightsTabs from "@/components/dashboard/InsightsTabs.vue";
import { effectivePosition } from "@/lib/positions";
import { useBoardDetail } from "@/composables/useBoards";
import { useUiStore } from "@/stores/ui";
import { api } from "@/lib/api";
import { queryKeys } from "@/lib/queryKeys";
import { CATEGORY_ORDER } from "@/composables/useProjectBoard";
import type {
  Resolution, StatusCategory, TicketSummary, UserRef, TicketType,
} from "@switchyard/shared";

const route = useRoute();
const router = useRouter();
const qc = useQueryClient();

const boardId = computed(() => {
  const v = route.params.id;
  return typeof v === "string" ? v : null;
});

const { board, columns, statusLookup, isLoading, error } = useBoardDetail(boardId);

// Default to "no swimlanes" — boards mingle their projects' tickets into a
// single grid. Users can opt into project / assignee / type rows from the
// header dropdown when they want the visual separation.
const swimlaneBy = ref<SwimlaneBy>("none");
const showEdit = ref(false);
const ui = useUiStore();

// Default project for the create dialog: first project on the board. Users
// can pick another from the project select inside the dialog.
const defaultProjectKey = computed(() => board.value?.projects[0]?.key ?? null);

// ─── flatten + group ───────────────────────────────────────────────────────
//
// Server returns columns grouped by category. We flatten into a single
// array, then group by the chosen swimlane key. The result is a 2-D matrix
// keyed by (swimlaneId, category) → tickets.
const allTickets = computed<TicketSummary[]>(() =>
  columns.value.flatMap((c) => c.tickets)
);

type Swimlane = {
  id: string;
  label: string;
  // Only show empty-state hint in cells of swimlanes that "exist" naturally
  // (e.g. an assignee row). Synthetic catch-all rows ("Unassigned") still
  // render hints. This is just a UX detail.
  ticketsByCategory: Map<StatusCategory, TicketSummary[]>;
};

const swimlanes = computed<Swimlane[]>(() => {
  const all = allTickets.value;
  if (swimlaneBy.value === "none") {
    return [{
      id: "all",
      label: "All tickets",
      ticketsByCategory: groupByCategory(all),
    }];
  }

  const buckets = new Map<string, { label: string; sortKey: string; tickets: TicketSummary[] }>();
  const ensure = (id: string, label: string, sortKey: string) => {
    if (!buckets.has(id)) buckets.set(id, { label, sortKey, tickets: [] });
    return buckets.get(id)!;
  };

  for (const t of all) {
    if (swimlaneBy.value === "project") {
      const b = ensure(t.project.id, t.project.name, t.project.key);
      b.tickets.push(t);
    } else if (swimlaneBy.value === "assignee") {
      const a: UserRef | null = t.assignee;
      const id = a?.id ?? "__unassigned__";
      const label = a?.name ?? "Unassigned";
      const sortKey = a ? a.name.toLowerCase() : "~"; // unassigned at the bottom
      const b = ensure(id, label, sortKey);
      b.tickets.push(t);
    } else if (swimlaneBy.value === "type") {
      const order: Record<TicketType, number> = { epic: 0, task: 1, bug: 2, spike: 3 };
      const b = ensure(t.type, capitalize(t.type), String(order[t.type] ?? 9));
      b.tickets.push(t);
    }
  }

  return [...buckets.entries()]
    .map(([id, v]) => ({
      id,
      label: v.label,
      sortKey: v.sortKey,
      ticketsByCategory: groupByCategory(v.tickets),
    }))
    .sort((a, b) => a.sortKey.localeCompare(b.sortKey));
});

function groupByCategory(tickets: TicketSummary[]): Map<StatusCategory, TicketSummary[]> {
  const out = new Map<StatusCategory, TicketSummary[]>();
  for (const cat of CATEGORY_ORDER) out.set(cat, []);
  for (const t of tickets) {
    const arr = out.get(t.status.category);
    if (arr) arr.push(t);
  }
  // Sort by effective position descending — manual reorders win, legacy rows
  // fall through to updated_at via effectivePosition.
  for (const arr of out.values()) {
    arr.sort((a, b) => effectivePosition(b) - effectivePosition(a));
  }
  return out;
}

function capitalize(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ─── transition mutation w/ cross-project status lookup ─────────────────────

type ColumnsResponse = {
  board: unknown;
  columns: { category: StatusCategory; tickets: TicketSummary[] }[];
};

const inflightTicketId = ref<string | null>(null);

const transitionMutation = useMutation({
  mutationFn: async (input: {
    ticketId: string;
    toStatusId: string;
    position?: number;
    resolution?: Resolution;
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
  onMutate: async (input) => {
    inflightTicketId.value = input.ticketId;
    if (!boardId.value) return;
    const key = queryKeys.boardColumns(boardId.value);
    await qc.cancelQueries({ queryKey: key });
    const previous = qc.getQueryData<ColumnsResponse>(key);
    if (!previous) return { previous };

    let movedTicket: TicketSummary | undefined;
    let toCategory: StatusCategory | undefined;
    for (const col of previous.columns) {
      const found = col.tickets.find((t) => t.id === input.ticketId);
      if (found) { movedTicket = found; break; }
    }
    if (!movedTicket) return { previous };

    if (input.reorderOnly) {
      // Same-category reorder: keep status, update position. Re-sort within
      // the category in the next render by setting the position; the parent
      // groups by category so nothing else changes.
      const optimistic: ColumnsResponse = {
        ...previous,
        columns: previous.columns.map((col) => ({
          ...col,
          tickets: col.tickets.map((t) =>
            t.id === input.ticketId
              ? { ...t, position: input.position ?? t.position, updated_at: new Date().toISOString() }
              : t
          ),
        })),
      };
      qc.setQueryData(key, optimistic);
      return { previous };
    }

    // Cross-category transition.
    for (const [, byCat] of statusLookup.value) {
      for (const [cat, st] of byCat) {
        if (st.id === input.toStatusId) { toCategory = cat; break; }
      }
      if (toCategory) break;
    }
    if (!toCategory) return { previous };

    const targetProject = statusLookup.value.get(movedTicket.project.id);
    const targetStatus = targetProject?.get(toCategory);
    if (!targetStatus) return { previous };

    const optimistic: ColumnsResponse = {
      ...previous,
      columns: previous.columns.map((col) => ({
        ...col,
        tickets:
          col.category === movedTicket!.status.category
            ? col.tickets.filter((t) => t.id !== input.ticketId)
            : col.category === toCategory
              ? [
                  ...col.tickets,
                  {
                    ...movedTicket!,
                    status: {
                      id: targetStatus.id,
                      category: targetStatus.category,
                      display_name: targetStatus.display_name,
                    },
                    resolution: input.resolution ?? null,
                    position: input.position ?? movedTicket!.position,
                    updated_at: new Date().toISOString(),
                  },
                ]
              : col.tickets,
      })),
    };
    qc.setQueryData(key, optimistic);
    return { previous };
  },
  onError: (err, _vars, ctx) => {
    if (boardId.value && ctx?.previous) {
      qc.setQueryData(queryKeys.boardColumns(boardId.value), ctx.previous);
    }
    const msg = (err as { error?: { message?: string } }).error?.message ?? "Transition failed";
    toast.error(msg);
  },
  onSettled: () => {
    inflightTicketId.value = null;
    if (boardId.value) {
      qc.invalidateQueries({ queryKey: queryKeys.boardColumns(boardId.value) });
    }
    qc.invalidateQueries({ queryKey: ["sw", "tickets"] });
  },
});

function handleDrop(ticketId: string, toCategory: StatusCategory, position: number) {
  // Find the ticket to learn its project + current category.
  const ticket = allTickets.value.find((t) => t.id === ticketId);
  if (!ticket) return;

  // Same-category drop ⇒ pure reorder. status_id and project don't change.
  if (ticket.status.category === toCategory) {
    transitionMutation.mutate({
      ticketId,
      toStatusId: ticket.status.id,
      position,
      reorderOnly: true,
    });
    return;
  }

  const projectMap = statusLookup.value.get(ticket.project.id);
  const targetStatus = projectMap?.get(toCategory);
  if (!targetStatus) {
    toast.error(
      `${ticket.project.key} has no ${capitalize(toCategory.replace("_", " "))} status. ` +
      `Add one before moving tickets here.`
    );
    return;
  }

  // Drag-to-closed defaults to `resolution: done` — same convention as the
  // single-project board. Bulk transition modal handles the explicit-pick
  // case for batch ops.
  transitionMutation.mutate({
    ticketId,
    toStatusId: targetStatus.id,
    position,
    resolution: toCategory === "closed" ? "done" : undefined,
  });
}

// closeOpen / pendingClose / confirmClose removed in 3.4 polish — drag-to-
// closed now auto-uses `done` resolution. Bulk transition modal handles
// the explicit-pick case for batch ops.

function openTicket(key: string) {
  router.push({ query: { ...route.query, focus: key } });
}

const errMessage = computed(() => {
  const e = error.value;
  if (!e) return null;
  return (e as { error?: { message?: string } }).error?.message ?? "Failed to load board";
});
</script>

<template>
  <div class="flex flex-col h-full">
    <!-- Header. Single row: back · | · board name · | · tabs · (filler) · controls.
         Back returns to /boards; tabs swap body within the same shell so the
         surrounding chrome stays put on tab change. -->
    <div class="border-b bg-background/95 backdrop-blur sticky top-0 z-10">
      <div class="px-4 h-12 flex items-center gap-2">
        <Button variant="ghost" size="sm" class="h-8 -ml-2" @click="router.push('/boards')">
          <ArrowLeft class="h-3.5 w-3.5 mr-1" /> Back
        </Button>
        <Separator orientation="vertical" class="h-5" />
        <span class="text-sm font-medium truncate">{{ board?.name ?? "Board" }}</span>
        <span v-if="board" class="text-[11px] text-muted-foreground whitespace-nowrap">
          · {{ board.projects.length }} project{{ board.projects.length === 1 ? "" : "s" }}
        </span>
        <Separator orientation="vertical" class="h-5" />
        <InsightsTabs
          :board-path="`/boards/${boardId}`"
          :insights-path="`/boards/${boardId}/insights`"
        />
        <div class="flex-1 min-w-0" />
        <SwimlaneSelector v-model="swimlaneBy" />
        <Button variant="outline" size="sm" class="h-8" :disabled="!board" @click="showEdit = true">
          <Pencil class="h-3.5 w-3.5 mr-1.5" /> Edit
        </Button>
        <Button size="sm" class="h-8" :disabled="!board" @click="ui.openCreateTicket(defaultProjectKey)">
          <Plus class="h-3.5 w-3.5 mr-1.5" /> New ticket
        </Button>
        <Loader2
          v-if="transitionMutation.isPending.value"
          class="h-4 w-4 text-muted-foreground animate-spin"
        />
      </div>
    </div>

    <!-- Loading -->
    <div v-if="isLoading" class="flex-1 p-4 grid grid-cols-5 gap-2">
      <Skeleton v-for="n in 15" :key="n" class="h-32 rounded-md" />
    </div>

    <!-- Error -->
    <div v-else-if="errMessage" class="flex-1 flex flex-col items-center justify-center text-center p-10">
      <AlertCircle class="h-8 w-8 text-destructive mb-2" />
      <p class="text-sm text-destructive">{{ errMessage }}</p>
    </div>

    <!-- Empty (board has no projects) -->
    <div
      v-else-if="!board || board.projects.length === 0"
      class="flex-1 flex flex-col items-center justify-center text-center p-10"
    >
      <Inbox class="h-10 w-10 text-muted-foreground/40 mb-3" />
      <h3 class="text-sm font-medium">This board has no projects.</h3>
      <Button variant="outline" size="sm" class="mt-3" @click="showEdit = true">
        Add projects
      </Button>
    </div>

    <!-- Grid -->
    <div v-else class="flex-1 overflow-auto p-4">
      <div
        class="grid gap-2 min-w-fit"
        :style="{
          gridTemplateColumns: swimlaneBy === 'none' ? 'repeat(5, minmax(14rem, 1fr))' : 'minmax(8rem, auto) repeat(5, minmax(14rem, 1fr))',
        }"
      >
        <!-- Column headers -->
        <div v-if="swimlaneBy !== 'none'" class="sticky top-0 z-[1]"></div>
        <div
          v-for="cat in CATEGORY_ORDER"
          :key="cat"
          class="text-xs font-medium uppercase tracking-wider text-muted-foreground px-2 py-1.5 bg-muted/30 rounded-md sticky top-0 z-[1] capitalize"
        >
          {{ cat.replace("_", " ") }}
        </div>

        <!-- Swimlane rows -->
        <template v-for="lane in swimlanes" :key="lane.id">
          <div
            v-if="swimlaneBy !== 'none'"
            class="text-sm font-medium px-2 py-2 bg-muted/20 rounded-md sticky left-0 z-[1] flex items-start gap-2"
          >
            <span class="truncate">{{ lane.label }}</span>
          </div>
          <BoardCell
            v-for="cat in CATEGORY_ORDER"
            :key="`${lane.id}-${cat}`"
            :category="cat"
            :tickets="lane.ticketsByCategory.get(cat) ?? []"
            :dragging-ticket-id="inflightTicketId"
            :show-empty-hint="false"
            @open="openTicket"
            @drop="(p) => handleDrop(p.ticketId, p.toCategory, p.position)"
          />
        </template>
      </div>
    </div>

    <EditBoardDialog v-if="board" v-model:open="showEdit" :board="board" />
  </div>
</template>
