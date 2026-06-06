// Saved views — wraps the /v1/views endpoints. Exposes the list query +
// create/update/delete mutations with cache invalidation.

import { useMutation, useQuery, useQueryClient } from "@tanstack/vue-query";
import { api } from "@/lib/api";
import { queryKeys } from "@/lib/queryKeys";
import type { CreateSavedView } from "@switchyard/shared";

export function useSavedViewsList() {
  return useQuery({
    queryKey: queryKeys.savedViews(),
    staleTime: 30 * 1000,
    queryFn: async () => {
      const { data, error } = await api.GET("/v1/views");
      if (error) throw error;
      return data;
    },
  });
}

export function useCreateSavedView() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: CreateSavedView) => {
      const { data, error } = await api.POST("/v1/views", { body });
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.savedViews() });
    },
  });
}

export function useDeleteSavedView() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await api.DELETE("/v1/views/{id}", {
        params: { path: { id } },
      });
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.savedViews() });
    },
  });
}
