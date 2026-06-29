// Plan-as-PR review surface (Phase 7.1). Loads a ticket's plan + its current
// revision, the revision history, the anchored comment thread, and exposes the
// review mutation (per-criterion verdicts + overall verdict) and the anchored-
// comment mutation. Mirrors useTicketDetail: one query per concern so cache
// invalidation stays granular.
//
// A ticket without a plan is the common case — the plan GET 404s, which we map
// to `null` (not an error) so the caller can simply hide the Plan tab.

import { computed, ref, type ComputedRef } from "vue";
import { useMutation, useQuery, useQueryClient } from "@tanstack/vue-query";
import { api } from "@/lib/api";
import { queryKeys } from "@/lib/queryKeys";
import type { Comment, PlanAnchor, SubmitReviewInput } from "@switchyard/shared";

export function useTicketPlan(idOrKey: ComputedRef<string | null>) {
  const qc = useQueryClient();
  const key = computed(() => idOrKey.value ?? "__none__");

  // The plan + its current revision (with diff-since-previous). 404 → null.
  const planQuery = useQuery({
    queryKey: computed(() => queryKeys.plan(key.value)),
    enabled: computed(() => idOrKey.value !== null),
    retry: false,
    queryFn: async () => {
      const v = idOrKey.value;
      if (!v) throw new Error("no idOrKey");
      const { data, error, response } = await api.GET("/v1/tickets/{idOrKey}/plan", {
        params: { path: { idOrKey: v } },
      });
      if (error) {
        if (response?.status === 404) return null; // no plan yet — not an error
        throw error;
      }
      return data;
    },
  });

  const plan = computed(() => planQuery.data.value ?? null);
  const hasPlan = computed(() => plan.value !== null);
  const currentRevision = computed(() => plan.value?.current_revision ?? null);

  // Revision history (newest first). Only fires once we know a plan exists.
  const revisionsQuery = useQuery({
    queryKey: computed(() => queryKeys.planRevisions(key.value)),
    enabled: computed(() => hasPlan.value),
    queryFn: async () => {
      const v = idOrKey.value;
      if (!v) throw new Error("no idOrKey");
      const { data, error } = await api.GET("/v1/tickets/{idOrKey}/plan/revisions", {
        params: { path: { idOrKey: v } },
      });
      if (error) throw error;
      return data;
    },
  });

  // Which revision the UI is viewing. `null` means "the current one" (served
  // straight from the plan payload); a number fetches that historical revision.
  const selectedRev = ref<number | null>(null);

  const historicalRevisionQuery = useQuery({
    queryKey: computed(() => queryKeys.planRevision(key.value, selectedRev.value ?? -1)),
    enabled: computed(() =>
      hasPlan.value &&
      selectedRev.value !== null &&
      selectedRev.value !== currentRevision.value?.rev_number,
    ),
    queryFn: async () => {
      const v = idOrKey.value;
      const rev = selectedRev.value;
      if (!v || rev === null) throw new Error("no revision");
      const { data, error } = await api.GET("/v1/tickets/{idOrKey}/plan/revisions/{rev}", {
        params: { path: { idOrKey: v, rev } },
      });
      if (error) throw error;
      return data;
    },
  });

  // The revision actually rendered: the historical fetch when one is selected,
  // otherwise the current revision embedded in the plan.
  const viewedRevision = computed(() => {
    const cur = currentRevision.value;
    if (selectedRev.value === null || selectedRev.value === cur?.rev_number) return cur;
    return historicalRevisionQuery.data.value ?? null;
  });
  const viewingCurrent = computed(
    () => viewedRevision.value !== null && viewedRevision.value.rev_number === currentRevision.value?.rev_number,
  );

  // Anchored comment thread for the CURRENT revision (the only reviewable one).
  // Fetched once and grouped by anchor in the component; small N per revision.
  const threadRevisionId = computed(() => currentRevision.value?.id ?? null);
  const threadQuery = useQuery({
    queryKey: computed(() => queryKeys.planThread(key.value, threadRevisionId.value ?? "__none__")),
    enabled: computed(() => threadRevisionId.value !== null),
    queryFn: async () => {
      const v = idOrKey.value;
      const revId = threadRevisionId.value;
      if (!v || !revId) throw new Error("no revision");
      const { data, error } = await api.GET("/v1/tickets/{idOrKey}/comments", {
        params: { path: { idOrKey: v }, query: { plan_revision_id: revId, limit: 200 } },
      });
      if (error) throw error;
      return data;
    },
  });

  const threadComments = computed<Comment[]>(() => threadQuery.data.value?.items ?? []);

  function invalidatePlan() {
    const v = idOrKey.value ?? "__none__";
    qc.invalidateQueries({ queryKey: queryKeys.plan(v) });
    qc.invalidateQueries({ queryKey: queryKeys.planRevisions(v) });
    qc.invalidateQueries({ queryKey: queryKeys.ticketEvents(v) });
    // The cross-ticket review queue + board badge index shift when a plan moves.
    qc.invalidateQueries({ queryKey: queryKeys.plans() });
  }

  // Submit a review of the current revision.
  const reviewMutation = useMutation({
    mutationFn: async (body: SubmitReviewInput) => {
      const v = idOrKey.value;
      const rev = currentRevision.value?.rev_number;
      if (!v || rev === undefined) throw new Error("no current revision to review");
      const { data, error } = await api.POST("/v1/tickets/{idOrKey}/plan/revisions/{rev}/review", {
        params: { path: { idOrKey: v, rev } },
        body,
      });
      if (error) throw error;
      return data;
    },
    onSuccess: () => invalidatePlan(),
  });

  // Post a comment anchored to the current revision (whole plan, a section, or a
  // criterion). Reuses the comments endpoint with the 7.0 plan anchor.
  const commentMutation = useMutation({
    mutationFn: async (input: { body: string; anchor: PlanAnchor }) => {
      const v = idOrKey.value;
      const revId = threadRevisionId.value;
      if (!v || !revId) throw new Error("no current revision");
      const { data, error } = await api.POST("/v1/tickets/{idOrKey}/comments", {
        params: { path: { idOrKey: v } },
        body: { body: input.body, plan_revision_id: revId, plan_anchor: input.anchor },
      });
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      const v = idOrKey.value ?? "__none__";
      const revId = threadRevisionId.value ?? "__none__";
      qc.invalidateQueries({ queryKey: queryKeys.planThread(v, revId) });
      qc.invalidateQueries({ queryKey: queryKeys.ticketEvents(v) });
    },
  });

  return {
    plan,
    hasPlan,
    isLoading: computed(() => planQuery.isLoading.value),
    error: computed(() => planQuery.error.value),
    currentRevision,
    revisions: computed(() => revisionsQuery.data.value?.items ?? []),
    revisionsLoading: computed(() => revisionsQuery.isLoading.value),
    selectedRev,
    viewedRevision,
    viewingCurrent,
    viewedRevisionLoading: computed(() => historicalRevisionQuery.isLoading.value),
    threadComments,
    threadLoading: computed(() => threadQuery.isLoading.value),
    reviewMutation,
    commentMutation,
  };
}
