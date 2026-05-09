<script setup lang="ts">
import { CornerUpLeft, Layers } from "lucide-vue-next";
import StatusBadge from "./StatusBadge.vue";
import TypeIcon from "./TypeIcon.vue";
import { Skeleton } from "@/components/ui/skeleton";
import type { Ticket, TicketSummary } from "@switchyard/shared";

defineProps<{
  parent: Ticket | null;
  parentLoading?: boolean;
  children: TicketSummary[];
  childrenLoading?: boolean;
  // If this ticket is itself an epic, we always render the children section
  // (even when empty) so the user knows where to add sub-tasks. For non-epics
  // we only render this whole component if parent is set.
  isEpic: boolean;
}>();

defineEmits<{
  navigate: [key: string];
}>();
</script>

<template>
  <section class="space-y-2">
    <h3 class="text-xs uppercase tracking-wider text-muted-foreground">Linked work</h3>

    <!-- Parent breadcrumb-style row -->
    <div v-if="parentLoading" class="flex items-center gap-2">
      <Skeleton class="h-7 w-48" />
    </div>
    <button
      v-else-if="parent"
      type="button"
      class="flex w-full items-center gap-2 rounded-md border bg-card px-2.5 py-1.5 text-left text-sm hover:bg-accent/40 transition-colors"
      @click="$emit('navigate', parent.key)"
    >
      <CornerUpLeft class="h-3.5 w-3.5 text-muted-foreground shrink-0" />
      <span class="text-xs text-muted-foreground">Parent</span>
      <TypeIcon :type="parent.type" />
      <span class="font-mono text-xs text-muted-foreground">{{ parent.key }}</span>
      <span class="flex-1 min-w-0 truncate font-medium">{{ parent.title }}</span>
      <StatusBadge :category="parent.status.category" :display-name="parent.status.display_name" size="sm" />
    </button>

    <!-- Children, only shown when this ticket is an epic -->
    <template v-if="isEpic">
      <div class="flex items-center gap-2 text-xs text-muted-foreground pt-1">
        <Layers class="h-3.5 w-3.5" />
        <span>Sub-tickets ({{ children.length }})</span>
      </div>

      <div v-if="childrenLoading" class="space-y-1.5">
        <Skeleton v-for="n in 3" :key="n" class="h-7 w-full" />
      </div>

      <ul v-else-if="children.length > 0" class="space-y-1">
        <li v-for="c in children" :key="c.id">
          <button
            type="button"
            class="flex w-full items-center gap-2 rounded-md border bg-card px-2.5 py-1.5 text-left text-sm hover:bg-accent/40 transition-colors"
            @click="$emit('navigate', c.key)"
          >
            <TypeIcon :type="c.type" />
            <span class="font-mono text-xs text-muted-foreground">{{ c.key }}</span>
            <span class="flex-1 min-w-0 truncate">{{ c.title }}</span>
            <StatusBadge :category="c.status.category" :display-name="c.status.display_name" size="sm" />
          </button>
        </li>
      </ul>

      <p v-else class="text-xs text-muted-foreground italic">
        No sub-tickets yet. Create a ticket and set this epic as its parent.
      </p>
    </template>
  </section>
</template>
