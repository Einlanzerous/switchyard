// Board-level "plan in review" index (Phase 7.1). A board renders many cards;
// rather than have each card fetch its ticket's plan (N+1), the board view runs
// ONE query for all in-review plans the user can read and provides the set of
// their ticket ids down the tree. BoardCard injects it to decide whether to show
// the "plan in review" badge — the same one-query-feeds-many shape the external-
// ref badges already use (embedded on the summary), kept out-of-band here so the
// god-node ticket summary doesn't grow a plan field just for a badge.

import { computed, inject, provide, type ComputedRef, type InjectionKey } from "vue";
import { useQuery } from "@tanstack/vue-query";
import { api } from "@/lib/api";
import { queryKeys } from "@/lib/queryKeys";

const PlanReviewIndexKey: InjectionKey<ComputedRef<Set<string>>> = Symbol("planReviewIndex");

// Called once by a board view. Fetches in-review plans across readable projects
// (a small set) and provides the ticket-id set to descendant cards.
export function providePlanReviewIndex(): ComputedRef<Set<string>> {
  const plansQuery = useQuery({
    queryKey: queryKeys.plans({ status: "in_review" }),
    staleTime: 30 * 1000,
    queryFn: async () => {
      const { data, error } = await api.GET("/v1/plans", {
        params: { query: { status: "in_review", limit: 200 } },
      });
      if (error) throw error;
      return data;
    },
  });
  const ids = computed(() => new Set((plansQuery.data.value?.items ?? []).map((p) => p.ticket.id)));
  provide(PlanReviewIndexKey, ids);
  return ids;
}

// Consumed by BoardCard. Defaults to an empty set when no board provided one
// (e.g. a card rendered outside a board context), so the badge simply hides.
export function usePlanReviewIndex(): ComputedRef<Set<string>> {
  return inject(
    PlanReviewIndexKey,
    computed(() => new Set<string>()),
  );
}
