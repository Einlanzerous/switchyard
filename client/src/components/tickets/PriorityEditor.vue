<script setup lang="ts">
import { computed } from "vue";
import { useMutation, useQueryClient } from "@tanstack/vue-query";
import { ChevronDown, Check, Loader2 } from "lucide-vue-next";
import { toast } from "vue-sonner";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import PriorityBadge from "./PriorityBadge.vue";
import { api } from "@/lib/api";
import { queryKeys } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import type { Ticket, Priority } from "@switchyard/shared";

const props = defineProps<{ ticket: Ticket }>();

const qc = useQueryClient();

// "Sentinel" entry for clearing the priority. Sent as null to the API.
const OPTIONS: Array<{ value: Priority | null; label: string }> = [
  { value: null, label: "No priority" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "critical", label: "Critical" },
];

const mutation = useMutation({
  mutationFn: async (priority: Priority | null) => {
    const { data, error } = await api.PATCH("/v1/tickets/{idOrKey}", {
      params: { path: { idOrKey: props.ticket.key } },
      // Sending null explicitly clears the field; undefined would just not patch.
      body: { priority: priority as Priority | undefined } as never,
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
    toast.success("Priority updated");
  },
});

const current = computed(() => props.ticket.priority);
</script>

<template>
  <DropdownMenu>
    <DropdownMenuTrigger as-child>
      <button
        type="button"
        :class="cn(
          'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-sm hover:bg-accent transition-colors',
          mutation.isPending.value && 'opacity-60',
        )"
        :disabled="mutation.isPending.value"
      >
        <Loader2 v-if="mutation.isPending.value" class="h-3.5 w-3.5 animate-spin" />
        <template v-else-if="current">
          <PriorityBadge :priority="current" show-label />
        </template>
        <span v-else class="text-muted-foreground italic">No priority</span>
        <ChevronDown class="h-3 w-3 text-muted-foreground/60" />
      </button>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="start" class="w-44">
      <DropdownMenuItem
        v-for="o in OPTIONS"
        :key="o.value ?? '__none__'"
        class="flex items-center gap-2 cursor-pointer"
        @click="mutation.mutate(o.value)"
      >
        <Check
          :class="cn('h-3.5 w-3.5', current === o.value ? 'text-primary' : 'opacity-0')"
        />
        <PriorityBadge v-if="o.value" :priority="o.value" />
        <span :class="!o.value && 'italic text-muted-foreground'">{{ o.label }}</span>
      </DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>
</template>
