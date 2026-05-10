// Composables for the dashboard surfaces.
//
// Each is a thin useQuery around an api.GET. Cache-aware staleTime so the
// dashboard doesn't refetch every widget on a tab focus, but is still
// alive enough that fresh agent activity surfaces within a minute.

import { computed, type ComputedRef } from "vue";
import { useQuery } from "@tanstack/vue-query";
import { api } from "@/lib/api";
import { queryKeys } from "@/lib/queryKeys";

const STALE_60S = 60 * 1000;
const STALE_30S = 30 * 1000;

export function useStaleRollup() {
  return useQuery({
    queryKey: queryKeys.statsStale(),
    staleTime: STALE_60S,
    queryFn: async () => {
      const { data, error } = await api.GET("/v1/stats/stale");
      if (error) throw error;
      return data;
    },
  });
}

export function useThroughput(params: ComputedRef<{
  project?: string;
  since?: string;
  until?: string;
  bucket?: "day" | "week";
}>) {
  return useQuery({
    queryKey: computed(() => queryKeys.statsThroughput(params.value)),
    staleTime: STALE_30S,
    queryFn: async () => {
      const { data, error } = await api.GET("/v1/stats/throughput", {
        params: { query: params.value as never },
      });
      if (error) throw error;
      return data;
    },
  });
}

export function useCycleTime(params: ComputedRef<{
  project?: string;
  since?: string;
  until?: string;
}>) {
  return useQuery({
    queryKey: computed(() => queryKeys.statsCycleTime(params.value)),
    staleTime: STALE_30S,
    queryFn: async () => {
      const { data, error } = await api.GET("/v1/stats/cycle-time", {
        params: { query: params.value as never },
      });
      if (error) throw error;
      return data;
    },
  });
}

export function useCumulativeFlow(params: ComputedRef<{
  project?: string;
  since?: string;
  until?: string;
  bucket?: "day" | "week";
}>) {
  return useQuery({
    queryKey: computed(() => queryKeys.statsCumulativeFlow(params.value)),
    staleTime: STALE_30S,
    queryFn: async () => {
      const { data, error } = await api.GET("/v1/stats/cumulative-flow", {
        params: { query: params.value as never },
      });
      if (error) throw error;
      return data;
    },
  });
}
