<script setup lang="ts">
import { formatDistanceToNow } from "date-fns";
import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";
import UserAvatar from "@/components/UserAvatar.vue";
import PlanStatusBadge from "./PlanStatusBadge.vue";
import type { PlanRevisionSummary } from "@switchyard/shared";

// The revision timeline. Selecting a row routes the viewer to that revision's
// snapshot + diff-since-previous; the current revision is the default view.
const props = defineProps<{
  revisions: PlanRevisionSummary[];
  currentRevNumber: number | null;
  // null = viewing current.
  selectedRev: number | null;
  loading?: boolean;
}>();

const emit = defineEmits<{
  select: [rev: number | null];
}>();

function when(iso: string): string {
  try {
    return formatDistanceToNow(new Date(iso), { addSuffix: true });
  } catch {
    return "";
  }
}

function isViewed(rev: number): boolean {
  const sel = props.selectedRev ?? props.currentRevNumber;
  return sel === rev;
}
</script>

<template>
  <div>
    <h3 class="text-xs uppercase tracking-wider text-muted-foreground mb-2">
      Revisions
    </h3>

    <div v-if="loading" class="space-y-2">
      <Skeleton class="h-9 w-full" />
      <Skeleton class="h-9 w-full" />
    </div>

    <ul v-else class="space-y-1">
      <li v-for="r in revisions" :key="r.id">
        <button
          type="button"
          :class="cn(
            'w-full flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-left text-sm transition-colors',
            isViewed(r.rev_number)
              ? 'border-primary bg-primary/5'
              : 'border-transparent hover:bg-accent',
          )"
          @click="emit('select', r.rev_number === currentRevNumber ? null : r.rev_number)"
        >
          <span class="font-mono text-xs text-muted-foreground shrink-0">rev {{ r.rev_number }}</span>
          <PlanStatusBadge :status="r.status" size="sm" />
          <span
            v-if="r.rev_number === currentRevNumber"
            class="text-[10px] uppercase tracking-wider text-primary/80 font-semibold"
          >current</span>
          <span class="flex items-center gap-1 ml-auto text-xs text-muted-foreground min-w-0">
            <UserAvatar :user="r.submitted_by" size="sm" class="shrink-0" />
            <span class="truncate">{{ when(r.submitted_at) }}</span>
          </span>
        </button>
      </li>
    </ul>
  </div>
</template>
