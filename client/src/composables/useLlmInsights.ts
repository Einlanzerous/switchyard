// Composables for the Insights → LLM tab (SWY-48 / 5.1.2).
//
// Each tile is a thin useQuery around an api.GET under /v1/stats/llm/*. The same
// composables serve the global view (no `project`) and the per-project tab
// (`project=KEY`) — the scope is just a query param. Warn-list management
// (Admin → Observability) adds list + promote/reject mutations.

import { computed, type ComputedRef } from "vue";
import { useQuery, useMutation, useQueryClient } from "@tanstack/vue-query";
import { api } from "@/lib/api";
import { queryKeys } from "@/lib/queryKeys";

const STALE_30S = 30 * 1000;

// Window scope shared by most tiles. `project` omitted = global (all visible).
export type LlmWindowParams = {
  project?: string;
  since?: string;
  until?: string;
  bucket?: "day" | "week";
};

export function useLlmKpi(params: ComputedRef<LlmWindowParams>) {
  return useQuery({
    queryKey: computed(() => queryKeys.statsLlmKpi(params.value)),
    staleTime: STALE_30S,
    queryFn: async () => {
      const { data, error } = await api.GET("/v1/stats/llm/kpi", {
        params: { query: params.value as never },
      });
      if (error) throw error;
      return data;
    },
  });
}

export function useLlmTokenSpend(params: ComputedRef<LlmWindowParams>) {
  return useQuery({
    queryKey: computed(() => queryKeys.statsLlmTokenSpend(params.value)),
    staleTime: STALE_30S,
    queryFn: async () => {
      const { data, error } = await api.GET("/v1/stats/llm/token-spend", {
        params: { query: params.value as never },
      });
      if (error) throw error;
      return data;
    },
  });
}

export function useLlmCostLeaderboard(params: ComputedRef<LlmWindowParams>) {
  return useQuery({
    queryKey: computed(() => queryKeys.statsLlmCostLeaderboard(params.value)),
    staleTime: STALE_30S,
    queryFn: async () => {
      const { data, error } = await api.GET("/v1/stats/llm/cost-leaderboard", {
        params: { query: params.value as never },
      });
      if (error) throw error;
      return data;
    },
  });
}

export function useLlmLatency(params: ComputedRef<LlmWindowParams>) {
  return useQuery({
    queryKey: computed(() => queryKeys.statsLlmLatency(params.value)),
    staleTime: STALE_30S,
    queryFn: async () => {
      const { data, error } = await api.GET("/v1/stats/llm/latency", {
        params: { query: params.value as never },
      });
      if (error) throw error;
      return data;
    },
  });
}

export function useLlmErrorRate(params: ComputedRef<LlmWindowParams>) {
  return useQuery({
    queryKey: computed(() => queryKeys.statsLlmErrorRate(params.value)),
    staleTime: STALE_30S,
    queryFn: async () => {
      const { data, error } = await api.GET("/v1/stats/llm/error-rate", {
        params: { query: params.value as never },
      });
      if (error) throw error;
      return data;
    },
  });
}

export type LlmHitlParams = {
  project?: string;
  in_progress_hours?: number;
  silent_hours?: number;
};

export function useLlmHitlStalls(params: ComputedRef<LlmHitlParams>) {
  return useQuery({
    queryKey: computed(() => queryKeys.statsLlmHitlStalls(params.value)),
    staleTime: STALE_30S,
    queryFn: async () => {
      const { data, error } = await api.GET("/v1/stats/llm/hitl-stalls", {
        params: { query: params.value as never },
      });
      if (error) throw error;
      return data;
    },
  });
}

// ── warn-list (Admin → Observability) ────────────────────────────────────────

export type LlmPendingParams = {
  dimension?: "service" | "operation" | "model" | "provider";
  include_resolved?: "true" | "false";
};

export function useLlmPendingValues(params: ComputedRef<LlmPendingParams>) {
  return useQuery({
    queryKey: computed(() => queryKeys.llmPendingValues(params.value)),
    staleTime: STALE_30S,
    queryFn: async () => {
      const { data, error } = await api.GET("/v1/admin/llm-obs/pending-values", {
        params: { query: params.value as never },
      });
      if (error) throw error;
      return data;
    },
  });
}

export function useResolvePendingValue() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (vars: { id: string; action: "promote" | "reject" }) => {
      const path =
        vars.action === "promote"
          ? "/v1/admin/llm-obs/pending-values/{id}/promote"
          : "/v1/admin/llm-obs/pending-values/{id}/reject";
      const { data, error } = await api.POST(path as never, {
        params: { path: { id: vars.id } },
      } as never);
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["sw", "admin", "llm-obs", "pending-values"] });
    },
  });
}
