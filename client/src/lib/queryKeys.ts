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
  projectMembers: (key: string) => ["sw", "projects", key, "members"] as const,
  projectBoard: (key: string) => ["sw", "projects", key, "board"] as const,

  // Labels are global — single shared catalog across all projects.
  labels: () => ["sw", "labels"] as const,

  tickets: (filters?: Partial<TicketListFilters>) => ["sw", "tickets", filters ?? {}] as const,
  ticket: (idOrKey: string) => ["sw", "ticket", idOrKey] as const,
  ticketComments: (idOrKey: string) => ["sw", "ticket", idOrKey, "comments"] as const,
  ticketEvents: (idOrKey: string) => ["sw", "ticket", idOrKey, "events"] as const,
  ticketChildren: (idOrKey: string) => ["sw", "ticket", idOrKey, "children"] as const,

  // Plan-as-PR (Phase 7.1). The plan + its revisions hang off the ticket; the
  // anchored comment thread is keyed by revision so each revision's discussion
  // caches independently. `plans` is the cross-ticket review-queue / board index.
  plan: (idOrKey: string) => ["sw", "ticket", idOrKey, "plan"] as const,
  planRevisions: (idOrKey: string) => ["sw", "ticket", idOrKey, "plan", "revisions"] as const,
  planRevision: (idOrKey: string, rev: number) =>
    ["sw", "ticket", idOrKey, "plan", "revisions", rev] as const,
  planThread: (idOrKey: string, revisionId: string) =>
    ["sw", "ticket", idOrKey, "plan", "thread", revisionId] as const,
  plans: (params?: Record<string, unknown>) => ["sw", "plans", params ?? {}] as const,

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

  ticketTemplates: (projectKey: string) => ["sw", "projects", projectKey, "templates"] as const,
  ticketTemplate: (id: string) => ["sw", "templates", id] as const,
  ticketTemplateInstances: (id: string) => ["sw", "templates", id, "instances"] as const,

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

  // LLM Insights (SWY-48 / 5.1.2). Params (project scope + window) carried in
  // the key so the global and per-project tabs coexist in the cache.
  statsLlmKpi: (params: Record<string, unknown>) => ["sw", "stats", "llm", "kpi", params] as const,
  statsLlmTokenSpend: (params: Record<string, unknown>) =>
    ["sw", "stats", "llm", "token-spend", params] as const,
  statsLlmCostLeaderboard: (params: Record<string, unknown>) =>
    ["sw", "stats", "llm", "cost-leaderboard", params] as const,
  statsLlmLatency: (params: Record<string, unknown>) =>
    ["sw", "stats", "llm", "latency", params] as const,
  statsLlmErrorRate: (params: Record<string, unknown>) =>
    ["sw", "stats", "llm", "error-rate", params] as const,
  statsLlmHitlStalls: (params: Record<string, unknown>) =>
    ["sw", "stats", "llm", "hitl-stalls", params] as const,
  llmPendingValues: (params?: Record<string, unknown>) =>
    ["sw", "admin", "llm-obs", "pending-values", params ?? {}] as const,

  myNotifications: (params?: Record<string, unknown>) =>
    ["sw", "users", "me", "notifications", params ?? {}] as const,
  myUnreadCount: () => ["sw", "users", "me", "notifications", "unread-count"] as const,

  savedViews: () => ["sw", "views"] as const,
};
