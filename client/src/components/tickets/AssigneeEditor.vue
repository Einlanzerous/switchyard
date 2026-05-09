<script setup lang="ts">
import { computed, ref } from "vue";
import { useMutation, useQuery, useQueryClient } from "@tanstack/vue-query";
import { ChevronDown, Check, Loader2, User as UserIcon } from "lucide-vue-next";
import { toast } from "vue-sonner";
import {
  Popover, PopoverContent, PopoverTrigger,
} from "@/components/ui/popover";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { queryKeys } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import type { Ticket } from "@switchyard/shared";

const props = defineProps<{ ticket: Ticket }>();

const qc = useQueryClient();
const open = ref(false);
const search = ref("");

const usersQuery = useQuery({
  queryKey: queryKeys.users(),
  staleTime: 5 * 60 * 1000,
  queryFn: async () => {
    const { data, error } = await api.GET("/v1/users", { params: { query: { limit: 200 } } });
    if (error) throw error;
    return data;
  },
});

const filteredUsers = computed(() => {
  const all = usersQuery.data.value?.items ?? [];
  const q = search.value.trim().toLowerCase();
  if (!q) return all;
  return all.filter((u) => u.name.toLowerCase().includes(q));
});

const mutation = useMutation({
  mutationFn: async (assigneeId: string | null) => {
    const { data, error } = await api.PATCH("/v1/tickets/{idOrKey}", {
      params: { path: { idOrKey: props.ticket.key } },
      body: { assignee_id: assigneeId } as never,
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
    toast.success("Assignee updated");
    open.value = false;
  },
});

function pick(id: string | null) {
  mutation.mutate(id);
}

const currentInitials = computed(() => {
  const name = props.ticket.assignee?.name ?? "";
  return name.split(/\s+/).map((p) => p[0]?.toUpperCase() ?? "").slice(0, 2).join("");
});
</script>

<template>
  <Popover v-model:open="open">
    <PopoverTrigger as-child>
      <button
        type="button"
        :class="cn(
          'inline-flex items-center gap-1.5 rounded px-1.5 py-0.5 text-sm hover:bg-accent transition-colors',
          mutation.isPending.value && 'opacity-60',
        )"
        :disabled="mutation.isPending.value"
      >
        <Loader2 v-if="mutation.isPending.value" class="h-3.5 w-3.5 animate-spin" />
        <template v-else-if="ticket.assignee">
          <Avatar class="h-5 w-5">
            <AvatarFallback class="text-[9px]">{{ currentInitials }}</AvatarFallback>
          </Avatar>
          <span class="text-foreground">{{ ticket.assignee.name }}</span>
        </template>
        <span v-else class="inline-flex items-center gap-1.5 text-muted-foreground">
          <UserIcon class="h-3.5 w-3.5" /> Unassigned
        </span>
        <ChevronDown class="h-3 w-3 text-muted-foreground/60" />
      </button>
    </PopoverTrigger>
    <PopoverContent align="start" class="w-64 p-0">
      <div class="p-2 border-b">
        <Input
          v-model="search"
          placeholder="Search…"
          class="h-7 text-xs"
          autofocus
        />
      </div>
      <div class="max-h-56 overflow-auto py-1">
        <button
          type="button"
          class="flex w-full items-center gap-2 px-2 py-1.5 text-sm hover:bg-accent text-left"
          @click="pick(null)"
        >
          <Check
            :class="cn('h-3.5 w-3.5', !ticket.assignee ? 'text-primary' : 'opacity-0')"
          />
          <UserIcon class="h-3.5 w-3.5 text-muted-foreground" />
          <span class="italic text-muted-foreground">Unassigned</span>
        </button>
        <button
          v-for="u in filteredUsers"
          :key="u.id"
          type="button"
          class="flex w-full items-center gap-2 px-2 py-1.5 text-sm hover:bg-accent text-left"
          @click="pick(u.id)"
        >
          <Check
            :class="cn('h-3.5 w-3.5', ticket.assignee?.id === u.id ? 'text-primary' : 'opacity-0')"
          />
          <span class="flex-1 truncate">{{ u.name }}</span>
          <span class="text-[10px] text-muted-foreground">{{ u.type }}</span>
        </button>
        <p
          v-if="filteredUsers.length === 0"
          class="px-2 py-2 text-xs text-muted-foreground italic"
        >
          No users match "{{ search }}".
        </p>
      </div>
    </PopoverContent>
  </Popover>
</template>
