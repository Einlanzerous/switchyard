// Centralized query keys. Mutations invalidate using these factories so we
// don't drift between callers. Each factory returns a tuple-shaped key the
// rest of the app can pass straight into useQuery / invalidateQueries.

import type { TicketListFilters } from "@switchyard/shared";

export const queryKeys = {
  all: ["sw"] as const,

  usersMe: () => ["sw", "users", "me"] as const,
  users: () => ["sw", "users"] as const,
  user: (id: string) => ["sw", "users", id] as const,
  userTokens: (id: string) => ["sw", "users", id, "tokens"] as const,

  projects: (params?: { include_archived?: boolean }) =>
    ["sw", "projects", params ?? {}] as const,
  project: (key: string) => ["sw", "projects", key] as const,
  projectStatuses: (key: string) => ["sw", "projects", key, "statuses"] as const,
  projectTransitions: (key: string) => ["sw", "projects", key, "transitions"] as const,
  projectBoard: (key: string) => ["sw", "projects", key, "board"] as const,

  // Labels are global — single shared catalog across all projects.
  labels: () => ["sw", "labels"] as const,

  tickets: (filters?: Partial<TicketListFilters>) => ["sw", "tickets", filters ?? {}] as const,
  ticket: (idOrKey: string) => ["sw", "ticket", idOrKey] as const,
  ticketComments: (idOrKey: string) => ["sw", "ticket", idOrKey, "comments"] as const,
  ticketEvents: (idOrKey: string) => ["sw", "ticket", idOrKey, "events"] as const,
  ticketChildren: (idOrKey: string) => ["sw", "ticket", idOrKey, "children"] as const,

  events: (params?: Record<string, unknown>) => ["sw", "events", params ?? {}] as const,

  boards: () => ["sw", "boards"] as const,
  board: (id: string) => ["sw", "boards", id] as const,
  boardColumns: (id: string) => ["sw", "boards", id, "columns"] as const,

  webhooks: () => ["sw", "webhooks"] as const,
  webhook: (id: string) => ["sw", "webhooks", id] as const,
  webhookDeliveries: (id: string) => ["sw", "webhooks", id, "deliveries"] as const,
};
