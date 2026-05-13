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

  rules: (params?: Record<string, unknown>) => ["sw", "rules", params ?? {}] as const,
  rule: (id: string) => ["sw", "rules", id] as const,
  ruleFirings: (id: string) => ["sw", "rules", id, "firings"] as const,

  targets: () => ["sw", "targets"] as const,
  target: (id: string) => ["sw", "targets", id] as const,

  customFields: () => ["sw", "custom-fields"] as const,
  customField: (id: string) => ["sw", "custom-fields", id] as const,

  systemSettings: () => ["sw", "settings"] as const,

  // Stats endpoints. Bulk projects-stats is keyed without parameters since
  // it always returns the full set; per-project + windowed endpoints carry
  // their inputs in the key so different views can coexist in the cache.
  statsProjects: () => ["sw", "stats", "projects"] as const,
  projectStats: (key: string) => ["sw", "projects", key, "stats"] as const,
  statsThroughput: (params: Record<string, unknown>) =>
    ["sw", "stats", "throughput", params] as const,
  statsCycleTime: (params: Record<string, unknown>) =>
    ["sw", "stats", "cycle-time", params] as const,
  statsCumulativeFlow: (params: Record<string, unknown>) =>
    ["sw", "stats", "cumulative-flow", params] as const,
  statsStale: () => ["sw", "stats", "stale"] as const,

  myNotifications: (params?: Record<string, unknown>) =>
    ["sw", "users", "me", "notifications", params ?? {}] as const,
  myUnreadCount: () => ["sw", "users", "me", "notifications", "unread-count"] as const,

  savedViews: () => ["sw", "views"] as const,
};
