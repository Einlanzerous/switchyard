<script setup lang="ts">
import { Check, X, Circle, MessageSquare } from "lucide-vue-next";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import PlanThread from "./PlanThread.vue";
import type { Comment, PlanCriterion } from "@switchyard/shared";

// The acceptance-criteria list — the machine-checkable contract. Each row shows
// the criterion + its verdict, and (while reviewing the current revision) a
// per-item approve/reject control with an optional reviewer note. Threads anchor
// to a specific criterion via `criterion:<id>`.
//
// Verdict display deliberately distinguishes the three states: a hollow circle
// for an untouched (pending) criterion, a green check for approved, and an
// explicit red "rejected" for a reviewer-rejected one (a genuine negative
// verdict, not a neutral not-done marker).
type Verdict = "approved" | "rejected";

const props = defineProps<{
  criteria: PlanCriterion[];
  // True when this is the current, in-review revision and the user may review.
  editable: boolean;
  // Working review draft (position → verdict/note), owned by the parent.
  draft: Record<number, { verdict: Verdict | null; note: string }>;
  // criterion id → its anchored comments.
  threadsByCriterion: Record<string, Comment[]>;
  // Which criterion threads are expanded (id set held by the parent).
  openThreads: Record<string, boolean>;
  canWrite: boolean;
  posting?: boolean;
  pendingCommentId?: string | null;
}>();

const emit = defineEmits<{
  setVerdict: [position: number, verdict: Verdict | null];
  setNote: [position: number, note: string];
  toggleThread: [criterionId: string];
  postThread: [criterionId: string, body: string];
  editComment: [id: string, body: string];
  deleteComment: [id: string];
}>();

// The verdict shown for a row: the live draft when reviewing, else the
// server-recorded verdict.
function shownVerdict(c: PlanCriterion): "pending" | Verdict {
  if (props.editable) return props.draft[c.position]?.verdict ?? "pending";
  return c.verdict;
}

function threadCount(c: PlanCriterion): number {
  return props.threadsByCriterion[c.id]?.length ?? 0;
}
</script>

<template>
  <ul class="divide-y rounded-md border">
    <li v-for="c in criteria" :key="c.id" class="p-3 space-y-2">
      <div class="flex items-start gap-2.5">
        <!-- Verdict indicator -->
        <span class="mt-0.5 shrink-0" aria-hidden="true">
          <Check v-if="shownVerdict(c) === 'approved'" class="h-4 w-4 text-green-600 dark:text-green-400" />
          <X v-else-if="shownVerdict(c) === 'rejected'" class="h-4 w-4 text-red-600 dark:text-red-400" />
          <Circle v-else class="h-4 w-4 text-muted-foreground/40" />
        </span>

        <div class="flex-1 min-w-0 space-y-1">
          <p class="text-sm leading-snug">{{ c.text }}</p>

          <!-- Recorded reviewer note (read-only display) -->
          <p
            v-if="!editable && c.reviewer_note"
            class="text-xs text-muted-foreground border-l-2 border-red-400/50 pl-2"
          >
            {{ c.reviewer_note }}
          </p>
        </div>

        <!-- Review controls (current in-review revision only) -->
        <div v-if="editable" class="flex items-center gap-1 shrink-0">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            :class="cn(
              'h-7 w-7',
              draft[c.position]?.verdict === 'approved'
                ? 'bg-green-500/15 text-green-700 dark:text-green-300'
                : 'text-muted-foreground hover:text-green-600',
            )"
            :aria-label="`Approve: ${c.text}`"
            :aria-pressed="draft[c.position]?.verdict === 'approved'"
            @click="emit('setVerdict', c.position, draft[c.position]?.verdict === 'approved' ? null : 'approved')"
          >
            <Check class="h-4 w-4" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            :class="cn(
              'h-7 w-7',
              draft[c.position]?.verdict === 'rejected'
                ? 'bg-red-500/15 text-red-700 dark:text-red-300'
                : 'text-muted-foreground hover:text-red-600',
            )"
            :aria-label="`Reject: ${c.text}`"
            :aria-pressed="draft[c.position]?.verdict === 'rejected'"
            @click="emit('setVerdict', c.position, draft[c.position]?.verdict === 'rejected' ? null : 'rejected')"
          >
            <X class="h-4 w-4" />
          </Button>
        </div>

        <!-- Thread toggle -->
        <Button
          type="button"
          variant="ghost"
          size="sm"
          class="h-7 px-1.5 shrink-0 text-xs text-muted-foreground"
          :aria-label="`Discussion on: ${c.text}`"
          @click="emit('toggleThread', c.id)"
        >
          <MessageSquare class="h-3.5 w-3.5" />
          <span v-if="threadCount(c) > 0" class="ml-1">{{ threadCount(c) }}</span>
        </Button>
      </div>

      <!-- Reviewer note input when rejecting -->
      <div v-if="editable && draft[c.position]?.verdict === 'rejected'" class="pl-6">
        <input
          :value="draft[c.position]?.note ?? ''"
          type="text"
          class="w-full rounded-md border bg-background px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
          placeholder="Why is this rejected? (optional note for the agent)"
          @input="emit('setNote', c.position, ($event.target as HTMLInputElement).value)"
        />
      </div>

      <!-- Anchored thread -->
      <div v-if="openThreads[c.id]" class="pl-6 pt-1">
        <PlanThread
          :comments="threadsByCriterion[c.id] ?? []"
          :can-write="canWrite"
          :posting="posting"
          :pending-comment-id="pendingCommentId"
          compact
          placeholder="Discuss this criterion… Ctrl+Enter to send."
          @post="(body) => emit('postThread', c.id, body)"
          @edit-comment="(id, body) => emit('editComment', id, body)"
          @delete-comment="(id) => emit('deleteComment', id)"
        />
      </div>
    </li>
  </ul>
</template>
