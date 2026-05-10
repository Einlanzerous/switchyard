<script setup lang="ts">
import { computed } from "vue";
import { useMutation, useQueryClient } from "@tanstack/vue-query";
import { ChevronDown, Loader2, ArrowRight } from "lucide-vue-next";
import { toast } from "vue-sonner";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import StatusBadge from "./StatusBadge.vue";
import { api } from "@/lib/api";
import { queryKeys } from "@/lib/queryKeys";
import type { Status, Ticket, Resolution } from "@switchyard/shared";

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
  onSuccess: () => {
    qc.invalidateQueries({ queryKey: queryKeys.ticket(props.ticket.key) });
    qc.invalidateQueries({ queryKey: queryKeys.ticketEvents(props.ticket.key) });
    qc.invalidateQueries({ queryKey: ["sw", "tickets"] });
    qc.invalidateQueries({ queryKey: ["sw", "projects"] });
    qc.invalidateQueries({ queryKey: ["sw", "boards"] });
    qc.invalidateQueries({ queryKey: ["sw", "stats"] });
    toast.success("Status changed");
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
  </div>
</template>
