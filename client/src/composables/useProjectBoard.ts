// Single-project kanban data.
//
// Fetches the project's statuses and all of its non-deleted tickets, groups
// the tickets by canonical status category, and exposes the result as a stable
// array of columns ordered backlog → planning → in_progress → blocked → closed.
//
// Multiple statuses can share a category (e.g. "On Hold" + "Stuck" both being
// blocked); we still render one column per category but track which underlying
// status is the drop target. The status with the lowest `position` wins.

import { computed, type ComputedRef } from "vue";
import { useQuery } from "@tanstack/vue-query";
import { api } from "@/lib/api";
import { queryKeys } from "@/lib/queryKeys";
import type { Status, StatusCategory, TicketSummary } from "@switchyard/shared";

export const CATEGORY_ORDER: StatusCategory[] = [
  "backlog",
  "planning",
  "in_progress",
  "blocked",
  "closed",
];

export type BoardColumn = {
  category: StatusCategory;
  // Display name for the column header. Pulled from the lowest-position
  // status in this category. Falls back to the category name when the
  // project has no status of this category at all (in which case the column
  // is hidden — see `useProjectBoard().columns`).
  displayName: string;
  // The status row a card transitions INTO when dropped on this column. We
  // pick the lowest-position status; if multiple statuses share the
  // category, agents can refine via the drawer afterward.
  dropTargetStatusId: string;
  // All ticket summaries currently in this category, sorted newest-updated
  // first. Optimistic updates layer on top of this list.
  tickets: TicketSummary[];
};

const PAGE_LIMIT = 200;

export function useProjectBoard(projectKey: ComputedRef<string | null>) {
  const enabled = computed(() => projectKey.value !== null);

  const statusesQuery = useQuery({
    queryKey: computed(() => queryKeys.projectStatuses(projectKey.value ?? "__none__")),
    enabled,
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      const k = projectKey.value;
      if (!k) throw new Error("no project");
      const { data, error } = await api.GET("/v1/projects/{key}/statuses", {
        params: { path: { key: k } },
      });
      if (error) throw error;
      return data;
    },
  });

  const ticketsQuery = useQuery({
    queryKey: computed(() => queryKeys.projectBoard(projectKey.value ?? "__none__")),
    enabled,
    queryFn: async () => {
      const k = projectKey.value;
      if (!k) throw new Error("no project");
      const { data, error } = await api.GET("/v1/tickets", {
        params: { query: { project: k, limit: PAGE_LIMIT } },
      });
      if (error) throw error;
      return data;
    },
  });

  const statuses = computed<Status[]>(() => statusesQuery.data.value?.items ?? []);
  const tickets = computed<TicketSummary[]>(() => ticketsQuery.data.value?.items ?? []);

  // Build the column array. We materialize columns for every category that has
  // at least one status in the project, in canonical order. Categories the
  // project has no statuses for (e.g. a project that deleted Planning) are
  // skipped — the kanban shouldn't show empty unreachable columns.
  const columns = computed<BoardColumn[]>(() => {
    const byCategory = new Map<StatusCategory, Status[]>();
    for (const s of statuses.value) {
      const existing = byCategory.get(s.category) ?? [];
      existing.push(s);
      byCategory.set(s.category, existing);
    }
    // Sort each bucket by position so the drop-target is deterministic.
    for (const arr of byCategory.values()) {
      arr.sort((a, b) => a.position - b.position);
    }

    return CATEGORY_ORDER.flatMap((cat) => {
      const inCat = byCategory.get(cat);
      if (!inCat || inCat.length === 0) return [];
      const head = inCat[0]!;
      const ticketsInCol = tickets.value
        .filter((t) => t.status.category === cat)
        .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
      return [{
        category: cat,
        displayName: head.display_name,
        dropTargetStatusId: head.id,
        tickets: ticketsInCol,
      }];
    });
  });

  return {
    statuses,
    tickets,
    columns,
    isLoading: computed(() => statusesQuery.isLoading.value || ticketsQuery.isLoading.value),
    error: computed(() => statusesQuery.error.value ?? ticketsQuery.error.value),
    refetch: async () => {
      await Promise.all([statusesQuery.refetch(), ticketsQuery.refetch()]);
    },
  };
}
