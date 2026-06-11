<script setup lang="ts">
import { ref, computed, watch } from "vue";
import { useMutation, useQueryClient } from "@tanstack/vue-query";
import { ChevronDown, Loader2, X } from "lucide-vue-next";
import { toast } from "vue-sonner";
import {
  Popover, PopoverTrigger, PopoverContent,
} from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import DueDateBadge from "./DueDateBadge.vue";
import { api } from "@/lib/api";
import { queryKeys } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import { useTicketCanWrite } from "@/composables/useProjectPermissions";
import type { Ticket } from "@switchyard/shared";

const props = defineProps<{ ticket: Ticket; isOpen?: boolean }>();

const canWrite = useTicketCanWrite();
const qc = useQueryClient();
const popoverOpen = ref(false);
const inputValue = ref<string>(""); // YYYY-MM-DD or ""

// Seed the picker from the ticket's stored ISO date whenever the popover opens
// so editing always starts from the current value.
watch(popoverOpen, (open) => {
  if (!open) return;
  if (!props.ticket.due_date) {
    inputValue.value = "";
    return;
  }
  const d = new Date(props.ticket.due_date);
  if (!Number.isNaN(d.getTime())) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    inputValue.value = `${y}-${m}-${day}`;
  } else {
    inputValue.value = "";
  }
});

const mutation = useMutation({
  // ISO 8601 with offset → API stores as timestamp. Sending YYYY-MM-DDT00:00 in
  // the user's local zone anchors "overdue" / "this week" math to their
  // calendar, not UTC.
  mutationFn: async (dueIso: string | null) => {
    const { data, error } = await api.PATCH("/v1/tickets/{idOrKey}", {
      params: { path: { idOrKey: props.ticket.key } },
      body: { due_date: dueIso as string | undefined } as never,
    });
    if (error) throw error;
    return data;
  },
  onSuccess: () => {
    qc.invalidateQueries({ queryKey: queryKeys.ticket(props.ticket.key) });
    qc.invalidateQueries({ queryKey: queryKeys.ticket(props.ticket.id) });
    qc.invalidateQueries({ queryKey: queryKeys.ticketEvents(props.ticket.key) });
    qc.invalidateQueries({ queryKey: ["sw", "tickets"] });
    qc.invalidateQueries({ queryKey: ["sw", "projects"] });
    qc.invalidateQueries({ queryKey: ["sw", "boards"] });
    toast.success("Due date updated");
    popoverOpen.value = false;
  },
});

function toLocalIso(yyyymmdd: string): string {
  // Build an ISO timestamp anchored at local midnight on the chosen day. The
  // `datetime({ offset: true })` zod validator on the server requires a tz
  // offset; toISOString() shifts to UTC which can roll the date back one day
  // for users west of UTC. Manually compose with the local offset instead.
  const [y, m, d] = yyyymmdd.split("-").map(Number);
  if (!y || !m || !d) throw new Error("bad date");
  const local = new Date(y, m - 1, d, 0, 0, 0, 0);
  const offsetMin = -local.getTimezoneOffset(); // east of UTC = positive
  const sign = offsetMin >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMin);
  const oh = String(Math.floor(abs / 60)).padStart(2, "0");
  const om = String(abs % 60).padStart(2, "0");
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}T00:00:00${sign}${oh}:${om}`;
}

function save() {
  if (!inputValue.value) {
    mutation.mutate(null);
    return;
  }
  mutation.mutate(toLocalIso(inputValue.value));
}

function clearDate() {
  mutation.mutate(null);
}

const hasDate = computed(() => !!props.ticket.due_date);
</script>

<template>
  <Popover v-model:open="popoverOpen">
    <PopoverTrigger as-child>
      <button
        type="button"
        :class="cn(
          'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-sm hover:bg-accent transition-colors',
          mutation.isPending.value && 'opacity-60',
        )"
        :disabled="mutation.isPending.value || !canWrite"
      >
        <Loader2 v-if="mutation.isPending.value" class="h-3.5 w-3.5 animate-spin" />
        <DueDateBadge
          v-else-if="hasDate"
          :due-date="props.ticket.due_date"
          :is-open="props.isOpen"
          show-label
        />
        <span v-else class="text-muted-foreground italic">No due date</span>
        <ChevronDown v-if="canWrite" class="h-3 w-3 text-muted-foreground/60" />
      </button>
    </PopoverTrigger>
    <PopoverContent align="start" class="w-56 p-3">
      <div class="flex flex-col gap-2">
        <label class="text-xs text-muted-foreground">Due date</label>
        <input
          v-model="inputValue"
          type="date"
          class="rounded border bg-background px-2 py-1 text-sm"
          @keydown.enter="save"
        />
        <div class="flex items-center justify-between gap-2 pt-1">
          <Button
            v-if="hasDate"
            variant="ghost"
            size="sm"
            class="h-7 px-2 text-muted-foreground hover:text-destructive"
            @click="clearDate"
          >
            <X class="h-3.5 w-3.5 mr-1" /> Clear
          </Button>
          <span v-else />
          <Button size="sm" class="h-7 px-3" :disabled="!inputValue || mutation.isPending.value" @click="save">
            Save
          </Button>
        </div>
      </div>
    </PopoverContent>
  </Popover>
</template>
