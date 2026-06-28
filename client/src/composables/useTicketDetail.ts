// Ticket detail loading + the related queries the drawer/page need.
//
// Splits each concern into its own query so cache invalidation stays granular.

import { computed, type ComputedRef } from "vue";
import { useQuery } from "@tanstack/vue-query";
import { api } from "@/lib/api";
import { queryKeys } from "@/lib/queryKeys";

export function useTicketDetail(idOrKey: ComputedRef<string | null>) {
  const ticketQuery = useQuery({
    queryKey: computed(() => queryKeys.ticket(idOrKey.value ?? "__none__")),
    enabled: computed(() => idOrKey.value !== null),
    queryFn: async () => {
      const v = idOrKey.value;
      if (!v) throw new Error("no idOrKey");
      const { data, error } = await api.GET("/v1/tickets/{idOrKey}", {
        params: { path: { idOrKey: v } },
      });
      if (error) throw error;
      return data;
    },
  });

  const ticket = computed(() => ticketQuery.data.value);

  // Project key is needed to load statuses + transitions for the project.
  const projectKey = computed(() => ticket.value?.project.key ?? null);

  const statusesQuery = useQuery({
    queryKey: computed(() => queryKeys.projectStatuses(projectKey.value ?? "__none__")),
    enabled: computed(() => projectKey.value !== null),
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

  const transitionsQuery = useQuery({
    queryKey: computed(() => queryKeys.projectTransitions(projectKey.value ?? "__none__")),
    enabled: computed(() => projectKey.value !== null),
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      const k = projectKey.value;
      if (!k) throw new Error("no project");
      const { data, error } = await api.GET("/v1/projects/{key}/transitions", {
        params: { path: { key: k } },
      });
      if (error) throw error;
      return data;
    },
  });

  // Parent + children fetches power the LinkedWork section. Both are lazy:
  // parent only fires when ticket.parent_id is set; children only when this
  // ticket can have children (anything but a subtask — an epic's tasks, or a
  // task/bug/spike's subtasks).
  const parentId = computed(() => ticket.value?.parent_id ?? null);
  const parentQuery = useQuery({
    queryKey: computed(() => queryKeys.ticket(parentId.value ?? "__none__")),
    enabled: computed(() => parentId.value !== null),
    queryFn: async () => {
      const id = parentId.value;
      if (!id) throw new Error("no parent");
      const { data, error } = await api.GET("/v1/tickets/{idOrKey}", {
        params: { path: { idOrKey: id } },
      });
      if (error) throw error;
      return data;
    },
  });

  const childrenQuery = useQuery({
    queryKey: computed(() => queryKeys.ticketChildren(idOrKey.value ?? "__none__")),
    enabled: computed(() => ticket.value != null && ticket.value.type !== "subtask"),
    queryFn: async () => {
      const v = idOrKey.value;
      if (!v) throw new Error("no idOrKey");
      const { data, error } = await api.GET("/v1/tickets/{idOrKey}/children", {
        params: { path: { idOrKey: v } },
      });
      if (error) throw error;
      return data;
    },
  });

  const eventsQuery = useQuery({
    queryKey: computed(() => queryKeys.ticketEvents(idOrKey.value ?? "__none__")),
    enabled: computed(() => idOrKey.value !== null),
    queryFn: async () => {
      const v = idOrKey.value;
      if (!v) throw new Error("no idOrKey");
      const { data, error } = await api.GET("/v1/tickets/{idOrKey}/events", {
        params: { path: { idOrKey: v } },
      });
      if (error) throw error;
      return data;
    },
  });

  // Compute allowed transitions: zero rows in the table = wildcard (any status
  // except the current); any rows = whitelist with NULL-from as wildcard.
  const allowedStatuses = computed(() => {
    const all = statusesQuery.data.value?.items ?? [];
    const current = ticket.value?.status.id;
    if (!current || all.length === 0) return [];

    const transitions = transitionsQuery.data.value?.items ?? [];
    if (transitions.length === 0) {
      return all.filter((s) => s.id !== current);
    }
    const allowedIds = new Set<string>();
    for (const t of transitions) {
      if (t.from_status_id === null || t.from_status_id === current) {
        allowedIds.add(t.to_status_id);
      }
    }
    return all.filter((s) => allowedIds.has(s.id));
  });

  return {
    ticket,
    isLoading: computed(() => ticketQuery.isLoading.value),
    error: computed(() => ticketQuery.error.value),
    refetch: () => ticketQuery.refetch(),
    allowedStatuses,
    events: computed(() => eventsQuery.data.value?.items ?? []),
    eventsLoading: computed(() => eventsQuery.isLoading.value),
    projectKey,
    parent: computed(() => parentQuery.data.value ?? null),
    parentLoading: computed(() => parentQuery.isLoading.value),
    children: computed(() => childrenQuery.data.value?.items ?? []),
    childrenLoading: computed(() => childrenQuery.isLoading.value),
  };
}
