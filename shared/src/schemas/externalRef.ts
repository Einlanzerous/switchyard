import { z } from "zod";
import { Uuid, Iso8601 } from "./common.js";
import { UserRef } from "./user.js";

// First-class display of GitHub PR / issue / commit / Actions state on
// tickets. Manual attach + state polling lands in 4.5.2 (this module);
// the webhook receiver + auto-detect from PR title / branch convention
// is 4.5.3 and builds the same rows from a different code path.

export const ExternalRefKind = z.enum([
  "github_pr", "github_issue", "github_commit", "github_action", "generic",
]);
export type ExternalRefKind = z.infer<typeof ExternalRefKind>;

export const ExternalRefState = z.enum([
  "open", "closed", "merged", "success", "failed",
]);
export type ExternalRefState = z.infer<typeof ExternalRefState>;

export const ExternalRef = z.object({
  id: Uuid,
  ticket_id: Uuid,
  kind: ExternalRefKind,
  url: z.string().url(),
  state: ExternalRefState.nullable(),
  title: z.string().nullable(),
  polled_at: Iso8601.nullable(),
  polled_state_changed_at: Iso8601.nullable(),
  created_at: Iso8601,
  created_by: UserRef,
});
export type ExternalRef = z.infer<typeof ExternalRef>;

export const CreateExternalRef = z.object({
  // Caller may force a kind. When omitted, the server infers from URL
  // shape (see lib/externalRefs/detectKind.ts). Use `kind: "generic"`
  // to skip URL validation entirely.
  kind: ExternalRefKind.optional(),
  url: z.string().url(),
});
export type CreateExternalRef = z.infer<typeof CreateExternalRef>;
