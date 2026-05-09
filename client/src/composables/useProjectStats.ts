// Wrappers around the Phase 3 stats endpoints.
//
// `useProjectsStats()` powers the Projects directory ticket-count column
// (single bulk query, cached). `useProjectStats(key)` is the per-project
// deep dive used by the future Insights tab.

import { computed, type ComputedRef } from "vue";
import { useQuery } from "@tanstack/vue-query";
import { api } from "@/lib/api";
import { queryKeys } from "@/lib/queryKeys";

export function useProjectsStats() {
  return useQuery({
    queryKey: queryKeys.statsProjects(),
    staleTime: 60 * 1000,
    queryFn: async () => {
      const { data, error } = await api.GET("/v1/stats/projects");
      if (error) throw error;
      return data;
    },
  });
}

export function useProjectStats(projectKey: ComputedRef<string | null>) {
  return useQuery({
    queryKey: computed(() => queryKeys.projectStats(projectKey.value ?? "__none__")),
    enabled: computed(() => projectKey.value !== null),
    staleTime: 30 * 1000,
    queryFn: async () => {
      const k = projectKey.value;
      if (!k) throw new Error("no project key");
      const { data, error } = await api.GET("/v1/projects/{key}/stats", {
        params: { path: { key: k } },
      });
      if (error) throw error;
      return data;
    },
  });
}
