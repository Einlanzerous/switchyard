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
import type { Status, Ticket, Resolution, TicketSummary, TicketType } from "@switchyard/shared";

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

    // Auto-close-parent prompt: if this transition just moved a child
    // into a closed category AND every sibling is now closed too, offer to
    // close the parent (an epic, or a task/bug/spike with subtasks). Pure-
    // frontend — we re-query the parent's children to confirm. The agent/PR
    // path is server-side and intentionally won't trigger this.
    const status = props.allowedStatuses.find((s) => s.id === vars.status_id);
    if (status?.category === "closed" && props.ticket.parent_id) {
      await maybePromptCloseParent(props.ticket.parent_id);
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

// ─── auto-close-parent prompt ──────────────────────────────────────────────
// Fires for any parent that can hold children — an epic (children = tasks) or a
// task/bug/spike (children = subtasks). The hard close-guard stays epic-only on
// the server; this is the human-path nudge only, and its copy adapts to the
// parent's type.

const parentPrompt = ref<{
  parentKey: string; parentId: string; parentType: TicketType; closedStatus: Status;
} | null>(null);
const closingParent = ref(false);

// Wording table: an epic has "children", everything else has "subtasks".
const promptCopy = computed(() => {
  const isEpic = parentPrompt.value?.parentType === "epic";
  return {
    noun: isEpic ? "epic" : "parent",
    children: isEpic ? "children" : "subtasks",
  };
});

async function maybePromptCloseParent(parentId: string) {
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
  // Don't prompt if the parent is already closed, or can't hold children
  // (a subtask is a leaf and never a parent — defensive).
  if (parent.status.category === "closed" || parent.type === "subtask") return;

  const children: TicketSummary[] = childrenRes.data.items ?? [];
  const allClosed = children.length > 0 && children.every((c) => c.status.category === "closed");
  if (!allClosed) return;

  parentPrompt.value = {
    parentKey: parent.key,
    parentId: parent.id,
    parentType: parent.type,
    closedStatus: closedTarget,
  };
}

async function confirmCloseParent() {
  const p = parentPrompt.value;
  if (!p) return;
  closingParent.value = true;
  try {
    const { error } = await api.POST("/v1/tickets/{idOrKey}/transition", {
      params: { path: { idOrKey: p.parentId } },
      body: { status_id: p.closedStatus.id, resolution: "done" },
    });
    if (error) {
      const msg = (error as { error?: { message?: string } })?.error?.message ?? "Failed to close parent";
      toast.error(msg);
      return;
    }
    qc.invalidateQueries({ queryKey: queryKeys.ticket(p.parentKey) });
    qc.invalidateQueries({ queryKey: ["sw", "tickets"] });
    qc.invalidateQueries({ queryKey: ["sw", "boards"] });
    toast.success(`${p.parentKey} closed`);
  } finally {
    closingParent.value = false;
    parentPrompt.value = null;
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
      :open="parentPrompt !== null"
      @update:open="(v) => { if (!v) parentPrompt = null; }"
    >
      <DialogContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Close the {{ promptCopy.noun }} too?</DialogTitle>
          <DialogDescription>
            All {{ promptCopy.children }} of
            <span class="font-mono">{{ parentPrompt?.parentKey }}</span>
            are now closed. Close the {{ promptCopy.noun }} with resolution "done"?
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" @click="parentPrompt = null">Leave open</Button>
          <Button :disabled="closingParent" @click="confirmCloseParent">
            <Loader2 v-if="closingParent" class="h-3.5 w-3.5 mr-1.5 animate-spin" />
            Close {{ promptCopy.noun }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>
