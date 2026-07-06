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

// Per-project activity pulse (SWY-136): last activity, 14d daily series,
// recent actors. Unwindowed — the server owns the 14-day definition.
export function useActivityPulse() {
  return useQuery({
    queryKey: queryKeys.statsActivityPulse(),
    staleTime: STALE_60S,
    queryFn: async () => {
      const { data, error } = await api.GET("/v1/stats/activity-pulse");
      if (error) throw error;
      return data;
    },
  });
}

// Epics in flight (SWY-137): open epics with child progress, driver, and the
// stalled flag ("no agent activity in stall_after_days").
export function useEpicsInFlight() {
  return useQuery({
    queryKey: queryKeys.statsEpics(),
    staleTime: STALE_60S,
    queryFn: async () => {
      const { data, error } = await api.GET("/v1/stats/epics");
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

// "Who did the work" leaderboard (SWY-151). `attribute: "assignee"` credits
// the ticket's assignee (closing-actor fallback when unassigned) so
// automations that merely execute closes don't absorb agent credit.
export function useClosedByActor(params: ComputedRef<{
  project?: string;
  since?: string;
  until?: string;
  attribute?: "actor" | "assignee";
}>) {
  return useQuery({
    queryKey: computed(() => queryKeys.statsClosedByActor(params.value)),
    staleTime: STALE_30S,
    queryFn: async () => {
      const { data, error } = await api.GET("/v1/stats/closed-by-actor", {
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
