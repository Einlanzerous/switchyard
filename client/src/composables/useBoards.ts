// Cross-project board queries.
//
// `useBoards()`        — list all boards (paginated).
// `useBoardDetail(id)` — fetch a single board + its columns + per-project
//                        status maps. The status maps are needed for
//                        cross-project drag: when a ticket from project A
//                        is dropped into the "In Progress" column, we have
//                        to look up A's specific In Progress status_id.

import { computed, type ComputedRef } from "vue";
import { useQuery, useQueries } from "@tanstack/vue-query";
import { api } from "@/lib/api";
import { queryKeys } from "@/lib/queryKeys";
import type { Status, StatusCategory } from "@switchyard/shared";

export function useBoardsList() {
  return useQuery({
    queryKey: queryKeys.boards(),
    queryFn: async () => {
      const { data, error } = await api.GET("/v1/boards", {
        params: { query: { limit: 200 } },
      });
      if (error) throw error;
      return data;
    },
  });
}

export type ProjectStatusMap = Map<StatusCategory, Status>;
// Outer map: projectId → its category-to-status map.
export type BoardStatusLookup = Map<string, ProjectStatusMap>;

export function useBoardDetail(boardId: ComputedRef<string | null>) {
  const enabled = computed(() => boardId.value !== null);

  const boardQuery = useQuery({
    queryKey: computed(() => queryKeys.board(boardId.value ?? "__none__")),
    enabled,
    queryFn: async () => {
      const id = boardId.value;
      if (!id) throw new Error("no board id");
      const { data, error } = await api.GET("/v1/boards/{id}", {
        params: { path: { id } },
      });
      if (error) throw error;
      return data;
    },
  });

  const columnsQuery = useQuery({
    queryKey: computed(() => queryKeys.boardColumns(boardId.value ?? "__none__")),
    enabled,
    queryFn: async () => {
      const id = boardId.value;
      if (!id) throw new Error("no board id");
      const { data, error } = await api.GET("/v1/boards/{id}/columns", {
        params: { path: { id } },
      });
      if (error) throw error;
      return data;
    },
    // Cross-project board mirrors single-project — keep ticket positions
    // fresh while the user watches agents work.
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
  });

  // Fan out one statuses fetch per project in the board. useQueries handles
  // both the parallelism and per-query cache keys.
  const projectKeys = computed(() =>
    boardQuery.data.value?.projects.map((p) => p.key) ?? []
  );

  const statusesQueries = useQueries({
    queries: computed(() =>
      projectKeys.value.map((key) => ({
        queryKey: queryKeys.projectStatuses(key),
        staleTime: 5 * 60 * 1000,
        queryFn: async () => {
          const { data, error } = await api.GET("/v1/projects/{key}/statuses", {
            params: { path: { key } },
          });
          if (error) throw error;
          return { key, items: data?.items ?? [] };
        },
      }))
    ),
  });

  // Build the cross-project status lookup. Lowest-position status per
  // (project, category) wins — same heuristic as the single-project board.
  const statusLookup = computed<BoardStatusLookup>(() => {
    const out: BoardStatusLookup = new Map();
    const projects = boardQuery.data.value?.projects ?? [];
    for (let i = 0; i < statusesQueries.value.length; i++) {
      const q = statusesQueries.value[i];
      const proj = projects[i];
      if (!proj || !q || !q.data) continue;
      const sorted = [...q.data.items].sort((a, b) => a.position - b.position);
      const byCategory: ProjectStatusMap = new Map();
      for (const s of sorted) {
        if (!byCategory.has(s.category)) byCategory.set(s.category, s);
      }
      out.set(proj.id, byCategory);
    }
    return out;
  });

  const isLoading = computed(() =>
    boardQuery.isLoading.value
    || columnsQuery.isLoading.value
    || statusesQueries.value.some((q) => q.isLoading)
  );

  const error = computed(() =>
    boardQuery.error.value
    ?? columnsQuery.error.value
    ?? statusesQueries.value.find((q) => q.error)?.error
  );

  return {
    board: computed(() => boardQuery.data.value ?? null),
    columns: computed(() => columnsQuery.data.value?.columns ?? []),
    statusLookup,
    isLoading,
    error,
  };
}
