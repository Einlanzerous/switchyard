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
import { effectivePosition } from "@/lib/positions";
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

export function useProjectBoard(
  projectKey: ComputedRef<string | null>,
  showEpics: ComputedRef<boolean> = computed(() => false),
) {
  const enabled = computed(() => projectKey.value !== null);

  // Settings + project metadata feed the effective Closed-column
  // window. The project's `board_closed_window_days` override (when
  // set) wins; otherwise we use the system default. Both refetch
  // once-per-mount and stick around — these change rarely.
  const settingsQuery = useQuery({
    queryKey: queryKeys.systemSettings(),
    enabled,
    staleTime: 60 * 60 * 1000,
    queryFn: async () => {
      const { data, error } = await api.GET("/v1/settings", {});
      if (error) throw error;
      return data;
    },
  });

  const projectQuery = useQuery({
    queryKey: computed(() => queryKeys.project(projectKey.value ?? "__none__")),
    enabled,
    staleTime: 60 * 60 * 1000,
    queryFn: async () => {
      const k = projectKey.value;
      if (!k) throw new Error("no project");
      const { data, error } = await api.GET("/v1/projects/{key}", { params: { path: { key: k } } });
      if (error) throw error;
      return data;
    },
  });

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
    // Background refresh while focused — kanban needs to reflect agent
    // activity without a manual reload. Statuses are static; only tickets
    // poll.
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
  });

  const statuses = computed<Status[]>(() => statusesQuery.data.value?.items ?? []);
  const tickets = computed<TicketSummary[]>(() => ticketsQuery.data.value?.items ?? []);

  // Effective Closed-column window: per-project override > system default.
  // Returned to consumers so the UI can render a "Closed (last X days)"
  // hint alongside the column header.
  const closedWindowDays = computed<number>(() => {
    // openapi-typescript emits `7 | 14 | 30 | unknown` for the
    // nullable literal-union (a known quirk with zod-openapi); narrow
    // by typeof here so the union resolves cleanly.
    const projOverride = projectQuery.data.value?.board_closed_window_days;
    if (typeof projOverride === "number") return projOverride;
    const sysDefault = settingsQuery.data.value?.board_closed_window_days;
    return typeof sysDefault === "number" ? sysDefault : 14;
  });

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

    // Closed column: drop tickets whose updated_at is older than the
    // effective window. Approximates "recently closed" — switchyard
    // doesn't track a separate closed_at, but the status transition
    // bumps updated_at via the trigger so it's accurate in practice.
    const closedCutoffMs = Date.now() - closedWindowDays.value * 24 * 60 * 60 * 1000;

    return CATEGORY_ORDER.flatMap((cat) => {
      const inCat = byCategory.get(cat);
      if (!inCat || inCat.length === 0) return [];
      const head = inCat[0]!;
      // Sort by effective position descending — manual reorder writes a
      // position; legacy rows fall through to updated_at via effectivePosition,
      // so all cards live on the same numeric axis.
      const ticketsInCol = tickets.value
        .filter((t) => t.status.category === cat)
        .filter((t) => showEpics.value || t.type !== "epic")
        .filter((t) => {
          if (cat !== "closed") return true;
          return new Date(t.updated_at).getTime() >= closedCutoffMs;
        })
        .sort((a, b) => effectivePosition(b) - effectivePosition(a));
      return [{
        category: cat,
        displayName: head.display_name,
        dropTargetStatusId: head.id,
        tickets: ticketsInCol,
      }];
    });
  });

  return {
    project: computed(() => projectQuery.data.value ?? null),
    statuses,
    tickets,
    columns,
    closedWindowDays,
    isLoading: computed(() => statusesQuery.isLoading.value || ticketsQuery.isLoading.value),
    error: computed(() => statusesQuery.error.value ?? ticketsQuery.error.value),
    refetch: async () => {
      await Promise.all([statusesQuery.refetch(), ticketsQuery.refetch()]);
    },
  };
}
