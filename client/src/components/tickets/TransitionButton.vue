<script setup lang="ts">
import { computed, ref } from "vue";
import { useMutation, useQueryClient } from "@tanstack/vue-query";
import { ChevronDown, Loader2, ArrowRight } from "lucide-vue-next";
import { toast } from "vue-sonner";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import StatusBadge from "./StatusBadge.vue";
import { api } from "@/lib/api";
import { queryKeys } from "@/lib/queryKeys";
import type { Status, Ticket, Resolution, TicketSummary } from "@switchyard/shared";

const props = defineProps<{
  ticket: Ticket;
  allowedStatuses: Status[];
}>();

const qc = useQueryClient();

// Closed-category transitions auto-use `done` resolution — same convention
// as drag-to-closed on the board. Picking `released` or `cancelled` is
// expected via the bulk transition modal (multi-ticket explicit case) or
// a future per-ticket resolution editor in the drawer body.
const transitionMutation = useMutation({
  mutationFn: async (input: { status_id: string; resolution?: Resolution }) => {
    const { data, error } = await api.POST("/v1/tickets/{idOrKey}/transition", {
      params: { path: { idOrKey: props.ticket.key } },
      body: input,
    });
    if (error) throw error;
    return data;
  },
  onSuccess: async (_data, vars) => {
    qc.invalidateQueries({ queryKey: queryKeys.ticket(props.ticket.key) });
    qc.invalidateQueries({ queryKey: queryKeys.ticketEvents(props.ticket.key) });
    qc.invalidateQueries({ queryKey: ["sw", "tickets"] });
    qc.invalidateQueries({ queryKey: ["sw", "projects"] });
    qc.invalidateQueries({ queryKey: ["sw", "boards"] });
    qc.invalidateQueries({ queryKey: ["sw", "stats"] });
    toast.success("Status changed");

    // Auto-close-epic prompt: if this transition just moved a child
    // into a closed category AND the parent is now the only thing
    // standing between this work and a closed epic, offer to close
    // the parent too. Pure-frontend — we re-query the parent's
    // children to confirm everyone else is also closed.
    const status = props.allowedStatuses.find((s) => s.id === vars.status_id);
    if (status?.category === "closed" && props.ticket.parent_id) {
      await maybePromptCloseEpic(props.ticket.parent_id);
    }
  },
  onError: (err) => {
    const msg = (err as { error?: { message?: string } })?.error?.message ?? "Transition failed";
    toast.error(msg);
  },
});

function pick(status: Status) {
  transitionMutation.mutate({
    status_id: status.id,
    resolution: status.category === "closed" ? "done" : undefined,
  });
}

const submitting = computed(() => transitionMutation.isPending.value);

// ─── auto-close-epic prompt ────────────────────────────────────────────────

const epicPrompt = ref<{ parentKey: string; parentId: string; closedStatus: Status } | null>(null);
const closingEpic = ref(false);

async function maybePromptCloseEpic(parentId: string) {
  // Find a closed-category status to transition the parent into. Reuse
  // the same status the child just moved to when possible — that keeps
  // the project's "default closed" convention coherent.
  const closedTarget = props.allowedStatuses.find((s) => s.category === "closed");
  if (!closedTarget) return; // shouldn't happen if the just-completed transition itself targeted closed

  const [parentRes, childrenRes] = await Promise.all([
    api.GET("/v1/tickets/{idOrKey}", { params: { path: { idOrKey: parentId } } }),
    api.GET("/v1/tickets/{idOrKey}/children", { params: { path: { idOrKey: parentId } } }),
  ]);
  if (parentRes.error || !parentRes.data) return;
  if (childrenRes.error || !childrenRes.data) return;

  const parent = parentRes.data;
  // Don't prompt if the parent is already closed or isn't an epic.
  if (parent.status.category === "closed" || parent.type !== "epic") return;

  const children: TicketSummary[] = childrenRes.data.items ?? [];
  const allClosed = children.length > 0 && children.every((c) => c.status.category === "closed");
  if (!allClosed) return;

  epicPrompt.value = {
    parentKey: parent.key,
    parentId: parent.id,
    closedStatus: closedTarget,
  };
}

async function confirmCloseEpic() {
  const p = epicPrompt.value;
  if (!p) return;
  closingEpic.value = true;
  try {
    const { error } = await api.POST("/v1/tickets/{idOrKey}/transition", {
      params: { path: { idOrKey: p.parentId } },
      body: { status_id: p.closedStatus.id, resolution: "done" },
    });
    if (error) {
      const msg = (error as { error?: { message?: string } })?.error?.message ?? "Failed to close epic";
      toast.error(msg);
      return;
    }
    qc.invalidateQueries({ queryKey: queryKeys.ticket(p.parentKey) });
    qc.invalidateQueries({ queryKey: ["sw", "tickets"] });
    qc.invalidateQueries({ queryKey: ["sw", "boards"] });
    toast.success(`${p.parentKey} closed`);
  } finally {
    closingEpic.value = false;
    epicPrompt.value = null;
  }
}
</script>

<template>
  <div class="inline-flex items-center gap-2">
    <DropdownMenu>
      <DropdownMenuTrigger as-child>
        <Button
          variant="outline"
          size="sm"
          class="h-8"
          :disabled="submitting || allowedStatuses.length === 0"
        >
          <Loader2 v-if="submitting" class="h-3.5 w-3.5 mr-1.5 animate-spin" />
          Transition to…
          <ChevronDown class="h-3.5 w-3.5 ml-1" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" class="w-60">
        <DropdownMenuLabel class="text-xs text-muted-foreground">
          From <span class="font-medium text-foreground">{{ ticket.status.display_name }}</span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <p
          v-if="allowedStatuses.length === 0"
          class="px-2 py-1.5 text-xs text-muted-foreground"
        >
          No transitions defined.
        </p>
        <DropdownMenuItem
          v-for="s in allowedStatuses"
          :key="s.id"
          class="flex items-center gap-2 cursor-pointer"
          @click="pick(s)"
        >
          <ArrowRight class="h-3.5 w-3.5 text-muted-foreground" />
          <StatusBadge :category="s.category" :display-name="s.display_name" size="sm" />
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>

    <Dialog
      :open="epicPrompt !== null"
      @update:open="(v) => { if (!v) epicPrompt = null; }"
    >
      <DialogContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Close the epic too?</DialogTitle>
          <DialogDescription>
            All children of
            <span class="font-mono">{{ epicPrompt?.parentKey }}</span>
            are now closed. Close the epic with resolution "done"?
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" @click="epicPrompt = null">Leave open</Button>
          <Button :disabled="closingEpic" @click="confirmCloseEpic">
            <Loader2 v-if="closingEpic" class="h-3.5 w-3.5 mr-1.5 animate-spin" />
            Close epic
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>
