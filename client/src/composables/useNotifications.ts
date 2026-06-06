// Notifications wrappers (3.3). Replaces the 3.1 live-scan with the
// persistent endpoint backed by the notifications table. The bell badge
// uses the cheap unread-count endpoint; the dropdown + homepage widget
// hit the full list endpoint.

import { computed, type MaybeRef, unref } from "vue";
import { useMutation, useQuery, useQueryClient } from "@tanstack/vue-query";
import { api } from "@/lib/api";
import { queryKeys } from "@/lib/queryKeys";
import type { MarkReadInput } from "@switchyard/shared";

// `since` accepts either a static ISO string or a reactive ref so widgets
// with a time-window selector can drive re-fetches by changing the window.
export function useNotifications(opts?: {
  status?: "all" | "unread";
  limit?: number;
  since?: MaybeRef<string | undefined>;
}) {
  const status = opts?.status ?? "unread";
  const limit = opts?.limit ?? 10;
  const sinceRef = opts?.since;
  return useQuery({
    queryKey: computed(() =>
      queryKeys.myNotifications({ status, limit, since: unref(sinceRef) })
    ),
    staleTime: 60 * 1000,
    queryFn: async () => {
      const since = unref(sinceRef);
      const query: Record<string, unknown> = { status, limit };
      if (since) query.since = since;
      const { data, error } = await api.GET("/v1/users/me/notifications", {
        params: { query: query as never },
      });
      if (error) throw error;
      return data;
    },
  });
}

export function useUnreadCount() {
  return useQuery({
    queryKey: queryKeys.myUnreadCount(),
    // Per spec: refetch on focus only, no interval polling. The bell value
    // is decay-tolerant and we don't want to hammer the endpoint.
    staleTime: 30 * 1000,
    refetchOnWindowFocus: true,
    queryFn: async () => {
      const { data, error } = await api.GET("/v1/users/me/notifications/unread-count");
      if (error) throw error;
      return data;
    },
  });
}

export function useMarkRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: MarkReadInput) => {
      const { data, error } = await api.POST("/v1/users/me/notifications/mark-read", { body });
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      // Invalidate every notifications query (the dropdown and widget both
      // re-fetch from their respective filtered slices).
      qc.invalidateQueries({ queryKey: ["sw", "users", "me", "notifications"] });
    },
  });
}

// Helper for the optimistic "mark this one read on click" flow used by
// both the bell dropdown and the homepage widget. Wraps the mutation so
// callers can `await` without setting up onSuccess each time.
export function useMarkOneRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { data, error } = await api.POST("/v1/users/me/notifications/mark-read", {
        body: { ids: [id] },
      });
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["sw", "users", "me", "notifications"] });
    },
  });
}
