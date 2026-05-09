// Cursor-paginated ticket list as TanStack useInfiniteQuery.
// Returns the same shape across pages and exposes flat `items` + paging refs.

import { computed, type ComputedRef } from "vue";
import { useInfiniteQuery } from "@tanstack/vue-query";
import { api } from "@/lib/api";
import { queryKeys } from "@/lib/queryKeys";
import type { TicketFilters } from "./useTicketFilters";

const PAGE_SIZE = 50;

export function useTicketsList(filters: ComputedRef<TicketFilters>) {
  const query = useInfiniteQuery({
    queryKey: computed(() => queryKeys.tickets(filters.value as Record<string, unknown>)),
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) => {
      const f = filters.value;
      const q: Record<string, unknown> = { limit: PAGE_SIZE };
      if (f.project.length) q.project = f.project.join(",");
      if (f.status.length) q.status = f.status.join(",");
      if (f.type.length) q.type = f.type.join(",");
      // priority isn't a top-level filter on the API today; client-filtered later.
      if (f.assignee) q.assignee = f.assignee;
      if (f.text) q.text = f.text;
      if (pageParam) q.cursor = pageParam;

      const { data, error } = await api.GET("/v1/tickets", {
        params: { query: q as never },
      });
      if (error) throw error;
      if (!data) throw new Error("empty response");
      return data;
    },
    getNextPageParam: (lastPage) =>
      lastPage.page.has_more ? (lastPage.page.next_cursor ?? undefined) : undefined,
    // Quietly refresh the list every 30s while the tab is focused so agent
    // activity (~90% of writes) shows up without forcing a manual refresh.
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
  });

  // Apply priority filter client-side (until the API supports it natively).
  const items = computed(() => {
    const flat = (query.data.value?.pages ?? []).flatMap((p) => p.items);
    const priorities = filters.value.priority;
    if (priorities.length === 0) return flat;
    return flat.filter((t) => t.priority && priorities.includes(t.priority));
  });

  return {
    query,
    items,
    isLoading: computed(() => query.isLoading.value),
    isFetchingNextPage: computed(() => query.isFetchingNextPage.value),
    hasNextPage: computed(() => !!query.hasNextPage.value),
    fetchNextPage: () => query.fetchNextPage(),
    error: computed(() => query.error.value),
  };
}
