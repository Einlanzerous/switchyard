import type { ApiTokenScope } from "@switchyard/shared";

// Scope catalog shared by every token-mint surface (self tokens in
// SettingsTokens, admin "mint for a user" in SettingsUsers). One source of
// truth so the labels/help stay consistent.
export const SCOPE_OPTIONS: Array<{ value: ApiTokenScope; label: string; help: string }> = [
  { value: "admin", label: "admin", help: "Bypass all per-scope checks." },
  { value: "tickets:read", label: "tickets:read", help: "Read tickets, comments, attachments." },
  { value: "tickets:write", label: "tickets:write", help: "Create / update / transition tickets." },
  { value: "comments:write", label: "comments:write", help: "Add / edit / delete comments." },
  { value: "attachments:write", label: "attachments:write", help: "Upload / delete attachments." },
  { value: "projects:manage", label: "projects:manage", help: "Manage projects, statuses, labels." },
  { value: "users:manage", label: "users:manage", help: "Create / edit / delete users + tokens." },
  { value: "webhooks:manage", label: "webhooks:manage", help: "Create / delete webhook subscriptions." },
];

// The default a fresh personal/agent token starts with — read + ticket/comment
// writes, the common imperium-loop shape. Returns a new Set each call so callers
// can mutate freely.
export function defaultTokenScopes(): Set<ApiTokenScope> {
  return new Set(["tickets:read", "tickets:write", "comments:write"]);
}
