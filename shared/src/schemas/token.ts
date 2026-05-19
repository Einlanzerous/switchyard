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

// Token name is human-readable: "claude-code", "n8n-cogitation", etc.
// hashed_token is never exposed; the plaintext token is only returned once on creation.
export const ApiToken = z
  .object({
    id: Uuid,
    user_id: Uuid,
    name: z.string().min(1).max(100),
    scopes: z.array(ApiTokenScope),
    last_used_at: Iso8601.nullable(),
    revoked_at: Iso8601.nullable(),
  })
  .merge(Timestamps);
export type ApiToken = z.infer<typeof ApiToken>;

export const CreateApiToken = z.object({
  name: z.string().min(1).max(100),
  scopes: z.array(ApiTokenScope).default(["admin"]),
});
export type CreateApiToken = z.infer<typeof CreateApiToken>;

export const ApiTokenWithSecret = ApiToken.extend({
  // Plaintext token: format `sw_<32 base32 chars>`. Returned once.
  token: z.string(),
});
export type ApiTokenWithSecret = z.infer<typeof ApiTokenWithSecret>;
