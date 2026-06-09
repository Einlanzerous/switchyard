import { z } from "zod";
import { Uuid, Iso8601, Timestamps } from "./common.js";

export const ApiTokenScope = z.enum([
  "tickets:read",
  "tickets:write",
  "comments:write",
  "attachments:write",
  "webhooks:manage",
  "projects:manage",
  "users:manage",
  "rules:manage",
  "targets:manage",
  "llm-obs:write",
  "admin",
]);
export type ApiTokenScope = z.infer<typeof ApiTokenScope>;

// Token kind. `dashboard` tokens are read-only by construction (scopes capped to
// READ_ONLY_SCOPES at creation), so they're safe to embed in a public/demo view.
// `agent` is descriptive-only — agent-ness derives from the owning user's type,
// not the token. Only `dashboard` carries enforced behavior.
export const ApiTokenKind = z.enum(["personal", "agent", "dashboard"]);
export type ApiTokenKind = z.infer<typeof ApiTokenKind>;

// The read-only scope bundle a `dashboard` token is restricted to. Today only
// `tickets:read` exists (it also gates reads of a ticket's comments/attachments);
// future `projects:read` / `comments:read` would join this set. This is the
// single source of truth for "what is read-only" — both the client dashboard
// dialog and the server validation consume it, so they can't drift.
export const READ_ONLY_SCOPES = ["tickets:read"] as const;

/** True when every scope is within the read-only bundle (the dashboard cap). */
export function isReadOnlyScopes(scopes: readonly ApiTokenScope[]): boolean {
  return scopes.every((s) => (READ_ONLY_SCOPES as readonly string[]).includes(s));
}

// Token name is human-readable: "claude-code", "n8n-cogitation", etc.
// hashed_token is never exposed; the plaintext token is only returned once on creation.
export const ApiToken = z
  .object({
    id: Uuid,
    user_id: Uuid,
    name: z.string().min(1).max(100),
    kind: ApiTokenKind,
    scopes: z.array(ApiTokenScope),
    last_used_at: Iso8601.nullable(),
    revoked_at: Iso8601.nullable(),
  })
  .merge(Timestamps);
export type ApiToken = z.infer<typeof ApiToken>;

// `scopes` is optional: the server fills the default per kind (dashboard →
// READ_ONLY_SCOPES, otherwise `admin`) and is the single authority that enforces
// the dashboard read-only cap — it rejects a write scope with a 400
// `invalid_scopes_for_kind` (a handler check, not a Zod refinement, so the error
// flows through the structured envelope rather than the raw validation shape).
export const CreateApiToken = z.object({
  name: z.string().min(1).max(100),
  kind: ApiTokenKind.default("personal"),
  scopes: z.array(ApiTokenScope).optional(),
});
export type CreateApiToken = z.infer<typeof CreateApiToken>;

export const ApiTokenWithSecret = ApiToken.extend({
  // Plaintext token: format `sw_<32 base32 chars>`. Returned once.
  token: z.string(),
});
export type ApiTokenWithSecret = z.infer<typeof ApiTokenWithSecret>;
