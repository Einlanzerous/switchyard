<script setup lang="ts">
import { computed, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useMutation, useQueryClient } from "@tanstack/vue-query";
import { ArrowLeft, List, Loader2, AlertCircle, Inbox, Plus } from "lucide-vue-next";
import { toast } from "vue-sonner";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import BoardColumn from "@/components/tickets/BoardColumn.vue";
import InsightsTabs from "@/components/dashboard/InsightsTabs.vue";
import { api } from "@/lib/api";
import { queryKeys } from "@/lib/queryKeys";
import { useUiStore } from "@/stores/ui";
import { useProjectBoard, type BoardColumn as Col } from "@/composables/useProjectBoard";

const ui = useUiStore();
import type { Resolution, TicketSummary } from "@switchyard/shared";

const route = useRoute();
const router = useRouter();
const qc = useQueryClient();

const projectKey = computed(() => {
  const v = route.params.key;
  return typeof v === "string" ? v : null;
});

const { columns, isLoading, error, refetch } = useProjectBoard(projectKey);

// ─── drop → transition wiring ────────────────────────────────────────────────

// Tracks which ticket is mid-drop so cards can dim during the operation.
const inflightTicketId = ref<string | null>(null);

// When a drop targets the closed column we hold the move pending until the
// user picks a resolution. Cancelling clears it without firing.
const pendingClose = ref<null | {
  ticketId: string;
  fromCategory: Col["category"];
  toStatusId: string;
  position: number;
}>(null);
const resolution = ref<Resolution>("done");

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
  if (payload.toCategory === "closed") {
    pendingClose.value = {
      ticketId: payload.ticketId,
      fromCategory: payload.fromCategory,
      toStatusId: payload.toStatusId,
      position: payload.position,
    };
    resolution.value = "done";
    return;
  }
  transitionMutation.mutate({
    ticketId: payload.ticketId,
    toStatusId: payload.toStatusId,
    position: payload.position,
  });
}

function confirmClose() {
  if (!pendingClose.value) return;
  transitionMutation.mutate({
    ticketId: pendingClose.value.ticketId,
    toStatusId: pendingClose.value.toStatusId,
    position: pendingClose.value.position,
    resolution: resolution.value,
  });
  pendingClose.value = null;
}

const closeOpen = computed({
  get: () => pendingClose.value !== null,
  set: (v: boolean) => { if (!v) pendingClose.value = null; },
});

// ─── ticket open (drawer) ────────────────────────────────────────────────────

function openTicket(key: string) {
  router.push({ query: { ...route.query, focus: key } });
}

// ─── nav back to list ────────────────────────────────────────────────────────

function viewAsList() {
  if (!projectKey.value) return;
  router.push({ path: "/tickets", query: { project: projectKey.value } });
}

const errMessage = computed(() => {
  const e = error.value;
  if (!e) return null;
  return (e as { error?: { message?: string } }).error?.message ?? "Failed to load board";
});
</script>

<template>
  <div class="flex flex-col h-full">
    <!-- Header -->
    <div class="border-b bg-background/95 backdrop-blur sticky top-0 z-10">
      <div class="px-4 py-2 flex items-center gap-3">
        <Button variant="ghost" size="sm" class="h-8 -ml-2" @click="viewAsList">
          <ArrowLeft class="h-3.5 w-3.5 mr-1" /> Back
        </Button>
        <div class="flex-1 min-w-0">
          <h1 class="font-semibold text-base flex items-center gap-2">
            <span class="font-mono text-muted-foreground">{{ projectKey }}</span>
          </h1>
        </div>
        <Button variant="outline" size="sm" class="h-8" @click="viewAsList">
          <List class="h-3.5 w-3.5 mr-1.5" /> List
        </Button>
        <Button size="sm" class="h-8" @click="ui.openCreateTicket(projectKey)">
          <Plus class="h-3.5 w-3.5 mr-1.5" /> New ticket
        </Button>
        <Loader2
          v-if="transitionMutation.isPending.value"
          class="h-4 w-4 text-muted-foreground animate-spin"
        />
      </div>
      <div class="px-4">
        <InsightsTabs
          :board-path="`/projects/${projectKey}/board`"
          :insights-path="`/projects/${projectKey}/insights`"
        />
      </div>
    </div>

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
          v-for="col in columns"
          :key="col.category"
          :column="col"
          :dragging-ticket-id="inflightTicketId"
          @open="openTicket"
          @drop="handleDrop"
        />
      </div>
    </div>

    <!-- Resolution prompt for closed-column drops -->
    <Dialog :open="closeOpen" @update:open="closeOpen = $event">
      <DialogContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Closing — pick a resolution</DialogTitle>
          <DialogDescription>
            Required when entering a Closed status.
          </DialogDescription>
        </DialogHeader>
        <div class="grid grid-cols-3 gap-1.5">
          <button
            v-for="r in (['done','released','cancelled'] as const)"
            :key="r"
            type="button"
            :class="[
              'rounded-md border px-2 py-2 text-sm font-medium capitalize transition-colors',
              resolution === r
                ? 'bg-primary text-primary-foreground border-primary'
                : 'bg-background text-muted-foreground hover:bg-accent hover:text-foreground border-border',
            ]"
            @click="resolution = r"
          >
            {{ r }}
          </button>
        </div>
        <DialogFooter>
          <Button variant="ghost" @click="pendingClose = null">Cancel</Button>
          <Button @click="confirmClose">
            <Loader2
              v-if="transitionMutation.isPending.value"
              class="h-3.5 w-3.5 mr-1.5 animate-spin"
            />
            Close ticket
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>
