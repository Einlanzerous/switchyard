<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import { useMutation, useQueryClient } from "@tanstack/vue-query";
import { ClipboardList, Loader2, ArrowLeft } from "lucide-vue-next";
import { toast } from "vue-sonner";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import EmptyState from "@/components/EmptyState.vue";
import Markdown from "@/components/markdown/Markdown.vue";
import { api } from "@/lib/api";
import { queryKeys } from "@/lib/queryKeys";
import { useTicketPlan } from "@/composables/useTicketPlan";
import { useTicketCanWrite } from "@/composables/useProjectPermissions";
import PlanStatusBadge from "./PlanStatusBadge.vue";
import PlanCriteriaList from "./PlanCriteriaList.vue";
import PlanDiffView from "./PlanDiffView.vue";
import PlanRevisionHistory from "./PlanRevisionHistory.vue";
import PlanThread from "./PlanThread.vue";
import type { Comment, SubmitReviewInput } from "@switchyard/shared";

type Verdict = "approved" | "rejected";

const props = defineProps<{
  ticketKey: string;
}>();

const qc = useQueryClient();
const idOrKey = computed(() => props.ticketKey);
const canWriteRef = useTicketCanWrite();
const canWrite = computed(() => canWriteRef.value);

const {
  plan, hasPlan, isLoading, error,
  currentRevision, revisions, revisionsLoading,
  selectedRev, viewedRevision, viewingCurrent, viewedRevisionLoading,
  threadComments, threadLoading,
  reviewMutation, commentMutation,
} = useTicketPlan(idOrKey);

const errMessage = computed(() => {
  const e = error.value;
  if (!e) return null;
  return (e as { error?: { message?: string } }).error?.message ?? "Failed to load plan";
});

// Only the current revision, while in review and writable, can be acted on.
const reviewable = computed(
  () => viewingCurrent.value && currentRevision.value?.status === "in_review" && canWrite.value,
);

// ─── review draft (per-criterion verdict + note, by position) ─────────────────

const draft = reactive<Record<number, { verdict: Verdict | null; note: string }>>({});
const openThreads = reactive<Record<string, boolean>>({});
const overallNote = ref("");

// Reset the working draft whenever the current revision changes (a fresh
// submission or a completed review supersedes any in-progress marks).
watch(
  () => currentRevision.value?.id,
  () => {
    for (const k of Object.keys(draft)) delete draft[Number(k)];
    for (const k of Object.keys(openThreads)) delete openThreads[k];
    overallNote.value = "";
  },
);

function setVerdict(position: number, verdict: Verdict | null) {
  const cur = draft[position] ?? { verdict: null, note: "" };
  draft[position] = { verdict, note: verdict === "rejected" ? cur.note : "" };
}
function setNote(position: number, note: string) {
  const cur = draft[position] ?? { verdict: null, note: "" };
  draft[position] = { ...cur, note };
}
function toggleThread(id: string) {
  openThreads[id] = !openThreads[id];
}

// ─── threads, grouped by anchor ───────────────────────────────────────────────

const threadsByCriterion = computed<Record<string, Comment[]>>(() => {
  const map: Record<string, Comment[]> = {};
  for (const c of threadComments.value) {
    const a = c.plan_anchor ?? "";
    if (a.startsWith("criterion:")) {
      const id = a.slice("criterion:".length);
      (map[id] ??= []).push(c);
    }
  }
  return map;
});

// Everything not anchored to a specific criterion (the whole-plan anchor and any
// section anchors) reads as the general plan discussion in v1.
const planLevelComments = computed<Comment[]>(() =>
  threadComments.value.filter((c) => !(c.plan_anchor ?? "").startsWith("criterion:")),
);

// ─── review actions ───────────────────────────────────────────────────────────

const criteria = computed(() => viewedRevision.value?.criteria ?? []);

const canRequestChanges = computed(
  () =>
    Object.values(draft).some((d) => d.verdict === "rejected") ||
    overallNote.value.trim().length > 0,
);

function submitReview(verdict: SubmitReviewInput["verdict"]) {
  if (!currentRevision.value) return;
  // For request-changes / reject, carry every explicit per-criterion mark. For
  // an approve-all, approve every criterion outright.
  let criteriaVerdicts: SubmitReviewInput["criteria_verdicts"];
  if (verdict === "approved") {
    criteriaVerdicts = currentRevision.value.criteria.map((c) => ({
      position: c.position,
      verdict: "approved" as const,
    }));
  } else {
    criteriaVerdicts = Object.entries(draft)
      .filter(([, d]) => d.verdict !== null)
      .map(([pos, d]) => ({
        position: Number(pos),
        verdict: d.verdict as Verdict,
        ...(d.verdict === "rejected" && d.note.trim() ? { reviewer_note: d.note.trim() } : {}),
      }));
  }

  reviewMutation.mutate(
    { verdict, note: overallNote.value.trim() || undefined, criteria_verdicts: criteriaVerdicts },
    {
      onSuccess: () => {
        toast.success(
          verdict === "approved"
            ? "Plan approved"
            : verdict === "rejected"
              ? "Plan rejected — sent back for rework"
              : "Changes requested",
        );
      },
      onError: (err: unknown) => {
        toast.error((err as { error?: { message?: string } })?.error?.message ?? "Review failed");
      },
    },
  );
}

// ─── anchored comment post + edit/delete ──────────────────────────────────────

function postThread(anchor: string, body: string) {
  commentMutation.mutate(
    { body, anchor: anchor as Comment["plan_anchor"] & string },
    {
      onError: (err: unknown) => {
        toast.error((err as { error?: { message?: string } })?.error?.message ?? "Failed to post comment");
      },
    },
  );
}

const pendingCommentId = ref<string | null>(null);

function invalidateThread() {
  const rid = currentRevision.value?.id ?? "__none__";
  qc.invalidateQueries({ queryKey: queryKeys.planThread(idOrKey.value, rid) });
  qc.invalidateQueries({ queryKey: queryKeys.ticketEvents(idOrKey.value) });
}

const editCommentMutation = useMutation({
  mutationFn: async ({ id, body }: { id: string; body: string }) => {
    const { error } = await api.PATCH("/v1/comments/{id}", { params: { path: { id } }, body: { body } });
    if (error) throw error;
  },
  onSuccess: () => invalidateThread(),
  onSettled: () => { pendingCommentId.value = null; },
});
const deleteCommentMutation = useMutation({
  mutationFn: async (id: string) => {
    const { error } = await api.DELETE("/v1/comments/{id}", { params: { path: { id } } });
    if (error) throw error;
  },
  onSuccess: () => invalidateThread(),
  onSettled: () => { pendingCommentId.value = null; },
});
function onEditComment(id: string, body: string) {
  pendingCommentId.value = id;
  editCommentMutation.mutate({ id, body });
}
function onDeleteComment(id: string) {
  pendingCommentId.value = id;
  deleteCommentMutation.mutate(id);
}
</script>

<template>
  <!-- Loading -->
  <div v-if="isLoading" class="space-y-3">
    <Skeleton class="h-5 w-40" />
    <Skeleton class="h-24 w-full" />
    <Skeleton class="h-32 w-full" />
  </div>

  <div v-else-if="errMessage" class="text-sm text-destructive">{{ errMessage }}</div>

  <EmptyState
    v-else-if="!hasPlan || !plan"
    :icon="ClipboardList"
    title="No plan yet"
    description="When an agent submits a plan for this ticket, it appears here for review."
    size="sm"
  />

  <div v-else class="space-y-5">
    <!-- Header -->
    <div class="flex flex-wrap items-center gap-2">
      <ClipboardList class="h-4 w-4 text-muted-foreground" />
      <span class="text-sm font-semibold">Plan</span>
      <span class="font-mono text-xs text-muted-foreground">{{ ticketKey }}</span>
      <PlanStatusBadge :status="plan.status" />
      <span class="text-xs text-muted-foreground">
        {{ plan.revision_count }} revision{{ plan.revision_count === 1 ? "" : "s" }}
      </span>
    </div>

    <!-- Viewing-history banner -->
    <div
      v-if="!viewingCurrent"
      class="flex items-center justify-between gap-2 rounded-md border border-amber-300/60 bg-amber-50 dark:bg-amber-950/30 px-3 py-2 text-xs"
    >
      <span class="text-amber-700 dark:text-amber-300">
        Viewing revision {{ viewedRevision?.rev_number }} (not current) — read-only.
      </span>
      <Button type="button" variant="ghost" size="sm" class="h-6 text-xs" @click="selectedRev = null">
        <ArrowLeft class="h-3 w-3 mr-1" /> Back to current
      </Button>
    </div>

    <div v-if="viewedRevisionLoading" class="space-y-2">
      <Skeleton class="h-24 w-full" />
    </div>

    <template v-else-if="viewedRevision">
      <!-- Narrative -->
      <section>
        <Markdown :body="viewedRevision.narrative_md" />
      </section>

      <!-- Diff since previous revision -->
      <section v-if="viewedRevision.diff" class="rounded-md border bg-muted/20 p-3">
        <PlanDiffView :diff="viewedRevision.diff" />
      </section>

      <!-- Acceptance criteria -->
      <section class="space-y-2">
        <h3 class="text-xs uppercase tracking-wider text-muted-foreground">
          Acceptance criteria · the contract
        </h3>
        <PlanCriteriaList
          :criteria="criteria"
          :editable="reviewable"
          :draft="draft"
          :threads-by-criterion="threadsByCriterion"
          :open-threads="openThreads"
          :can-write="canWrite"
          :posting="commentMutation.isPending.value"
          :pending-comment-id="pendingCommentId"
          @set-verdict="setVerdict"
          @set-note="setNote"
          @toggle-thread="toggleThread"
          @post-thread="(id, body) => postThread(`criterion:${id}`, body)"
          @edit-comment="onEditComment"
          @delete-comment="onDeleteComment"
        />
      </section>

      <!-- Review actions (current in-review revision only) -->
      <section v-if="reviewable" class="space-y-2 rounded-md border bg-card p-3">
        <textarea
          v-model="overallNote"
          rows="2"
          class="w-full rounded-md border bg-background p-2 text-sm leading-relaxed focus:outline-none focus:ring-1 focus:ring-ring resize-y"
          placeholder="Overall review note (required to request changes or reject)…"
        />
        <div class="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            class="bg-green-600 hover:bg-green-700 text-white"
            :disabled="reviewMutation.isPending.value"
            @click="submitReview('approved')"
          >
            <Loader2 v-if="reviewMutation.isPending.value" class="h-3.5 w-3.5 mr-1.5 animate-spin" />
            Approve all → Building
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            :disabled="reviewMutation.isPending.value || !canRequestChanges"
            @click="submitReview('changes_requested')"
          >
            Request changes
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            class="text-red-600 hover:text-red-700 hover:bg-red-500/10"
            :disabled="reviewMutation.isPending.value || overallNote.trim().length === 0"
            title="The approach is wrong — sends the plan back with a distinct signal"
            @click="submitReview('rejected')"
          >
            Reject approach
          </Button>
        </div>
        <p class="text-[11px] text-muted-foreground">
          Approving locks the acceptance criteria as the build's verification contract.
        </p>
      </section>

      <!-- Settled-state hint -->
      <p
        v-else-if="viewingCurrent && plan.status === 'changes_requested'"
        class="text-xs text-muted-foreground italic"
      >
        Changes requested — awaiting a new revision from the agent.
      </p>
      <p
        v-else-if="viewingCurrent && plan.status === 'approved'"
        class="text-xs text-green-700 dark:text-green-400"
      >
        Plan approved. The acceptance criteria are now the build's verification contract.
      </p>

      <!-- Plan-level discussion -->
      <section class="border-t pt-4 space-y-2">
        <h3 class="text-xs uppercase tracking-wider text-muted-foreground">Discussion</h3>
        <div v-if="threadLoading" class="space-y-2">
          <Skeleton class="h-8 w-full" />
        </div>
        <PlanThread
          v-else
          :comments="planLevelComments"
          :can-write="canWrite"
          :posting="commentMutation.isPending.value"
          :pending-comment-id="pendingCommentId"
          placeholder="Comment on the plan… markdown supported, Ctrl+Enter to send."
          @post="(body) => postThread('plan', body)"
          @edit-comment="onEditComment"
          @delete-comment="onDeleteComment"
        />
      </section>
    </template>

    <!-- Revision history -->
    <section class="border-t pt-4">
      <PlanRevisionHistory
        :revisions="revisions"
        :current-rev-number="currentRevision?.rev_number ?? null"
        :selected-rev="selectedRev"
        :loading="revisionsLoading"
        @select="(rev) => (selectedRev = rev)"
      />
    </section>
  </div>
</template>
