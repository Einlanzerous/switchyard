<script setup lang="ts">
// Top assignees by ticket count for a single project. Powered by the
// existing /v1/projects/:key/stats endpoint's `by_assignee` field.

import { computed } from "vue";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { useProjectStats } from "@/composables/useProjectStats";

const props = defineProps<{ projectKey: string }>();

const projectKeyComp = computed(() => props.projectKey);
const q = useProjectStats(projectKeyComp);

const top = computed(() => (q.data.value?.by_assignee ?? []).slice(0, 6));
const max = computed(() => top.value[0]?.count ?? 1);

function initials(name: string): string {
  return name.split(/\s+/).map((p) => p[0]?.toUpperCase() ?? "").slice(0, 2).join("");
}
</script>

<template>
  <!--
    px-3 py-2 wraps the rows in extra inset on top of CardContent's p-4, so
    avatars and counts both end up ~28px from the card edge. The bar gets
    `mr-1` so it never quite touches the count column.
  -->
  <div class="px-3 py-2">
    <ul v-if="top.length > 0" class="space-y-3">
      <li
        v-for="row in top"
        :key="row.user?.id ?? 'unassigned'"
        class="flex items-center gap-4 text-sm"
      >
        <Avatar class="h-6 w-6 shrink-0">
          <AvatarFallback class="text-[10px]">
            {{ row.user ? initials(row.user.name) : "—" }}
          </AvatarFallback>
        </Avatar>
        <span class="truncate w-24 sm:w-32 shrink-0">{{ row.user?.name ?? "Unassigned" }}</span>
        <div class="flex-1 min-w-0 h-2 bg-muted rounded-full overflow-hidden mr-1">
          <div
            class="h-full bg-primary/60 rounded-full"
            :style="{ width: `${(row.count / max) * 100}%` }"
          />
        </div>
        <span class="w-6 text-right tabular-nums text-xs text-muted-foreground shrink-0">
          {{ row.count }}
        </span>
      </li>
    </ul>
    <div v-else class="text-xs text-muted-foreground italic text-center py-4">
      No assignees yet.
    </div>
  </div>
</template>
