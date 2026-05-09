<script setup lang="ts">
import { ref, computed } from "vue";
import { useMutation, useQueryClient } from "@tanstack/vue-query";
import { ChevronDown, Loader2, ArrowRight } from "lucide-vue-next";
import { toast } from "vue-sonner";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import StatusBadge from "./StatusBadge.vue";
import { api } from "@/lib/api";
import { queryKeys } from "@/lib/queryKeys";
import type { Status, Ticket, Resolution } from "@switchyard/shared";

const props = defineProps<{
  ticket: Ticket;
  allowedStatuses: Status[];
}>();

const qc = useQueryClient();

// When the user picks a closed-category status, we open a small popover to
// select the resolution. Until then, target stays null.
const pendingTarget = ref<Status | null>(null);
const resolution = ref<Resolution>("done");

const isClosing = computed(() => pendingTarget.value?.category === "closed");

const transitionMutation = useMutation({
  mutationFn: async (input: { status_id: string; resolution?: Resolution }) => {
    const { data, error } = await api.POST("/v1/tickets/{idOrKey}/transition", {
      params: { path: { idOrKey: props.ticket.key } },
      body: input,
    });
    if (error) throw error;
    return data;
  },
  onSuccess: (_data, vars) => {
    qc.invalidateQueries({ queryKey: queryKeys.ticket(props.ticket.key) });
    qc.invalidateQueries({ queryKey: queryKeys.ticketEvents(props.ticket.key) });
    qc.invalidateQueries({ queryKey: ["sw", "tickets"] });
    pendingTarget.value = null;
    void vars;
    toast.success("Status changed");
  },
});

function pick(status: Status) {
  if (status.category === "closed") {
    pendingTarget.value = status;
    resolution.value = "done";
  } else {
    transitionMutation.mutate({ status_id: status.id });
  }
}

function confirmClose() {
  if (!pendingTarget.value) return;
  transitionMutation.mutate({
    status_id: pendingTarget.value.id,
    resolution: resolution.value,
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

    <!-- Resolution popover only mounts while a closed-category target is pending. -->
    <Popover :open="isClosing" @update:open="(v) => { if (!v) pendingTarget = null; }">
      <PopoverTrigger as-child>
        <span class="hidden" />
      </PopoverTrigger>
      <PopoverContent class="w-72 space-y-3" align="end">
        <div class="space-y-1">
          <h4 class="text-sm font-semibold">Closing — pick a resolution</h4>
          <p class="text-xs text-muted-foreground">
            Required when entering a Closed status.
          </p>
        </div>
        <div class="grid grid-cols-3 gap-1">
          <button
            v-for="r in (['done','released','cancelled'] as const)"
            :key="r"
            type="button"
            :class="[
              'rounded-md border px-2 py-1.5 text-xs font-medium capitalize transition-colors',
              resolution === r
                ? 'bg-primary text-primary-foreground border-primary'
                : 'bg-background text-muted-foreground hover:bg-accent hover:text-foreground border-border',
            ]"
            @click="resolution = r"
          >
            {{ r }}
          </button>
        </div>
        <div class="flex justify-end gap-2 pt-1 border-t">
          <Button variant="ghost" size="sm" :disabled="submitting" @click="pendingTarget = null">
            Cancel
          </Button>
          <Button size="sm" :disabled="submitting" @click="confirmClose">
            <Loader2 v-if="submitting" class="h-3.5 w-3.5 mr-1.5 animate-spin" />
            Close ticket
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  </div>
</template>
