import { z } from "zod";

// Signet blind-mirror contract (SWY-165 / SWY-164 epic). These mirror the JSON
// emitted by the Signet daemon's `signet serve` HTTP API
// (~/projects/signet: internal/api/server.go + internal/store/audit.go).
//
// Signet is a credential vault: it NEVER returns plaintext secret values across
// this boundary — only metadata, version hashes (`vhash`), sync state, and the
// append-only audit chain. Optional fields correspond to Go `omitempty`.
//
// Parsing is non-strict (unknown keys are stripped, not rejected) so a newer
// Signet that adds a field doesn't break the proxy; surfacing a new field to
// the UI is then a deliberate schema edit here.

export const SignetKeyState = z.object({
  key: z.string(),
  state: z.string(), // ok | missing | changed
});
export type SignetKeyState = z.infer<typeof SignetKeyState>;

// One fan-out destination (a GitHub Actions repo secret, or a rendered env
// file) and its computed sync state relative to the vault's current version.
export const SignetTargetView = z.object({
  kind: z.string(), // "gh-actions" | "file"
  repo: z.string().optional(),
  secret_name: z.string().optional(),
  path: z.string().optional(),
  state: z.string(), // in sync | drift | never | error | missing | changed
  last_pushed_at: z.string().optional(),
  last_error: z.string().optional(),
  keys: z.array(SignetKeyState).optional(),
});
export type SignetTargetView = z.infer<typeof SignetTargetView>;

// A secret's blind representation. No values, ever — `vhash` is the first 6 hex
// of SHA-256(nonce‖ciphertext), which is not derivable from plaintext alone.
export const SignetSecretView = z.object({
  name: z.string(),
  scope: z.string().optional(),
  status: z.string(),
  generated: z.boolean(),
  vhash: z.string().optional(),
  version_no: z.number().int(),
  expires_at: z.string().optional(),
  updated_at: z.string(),
  targets: z.array(SignetTargetView).optional(),
});
export type SignetSecretView = z.infer<typeof SignetSecretView>;

export const SignetProjectView = z.object({
  project: z.string(),
  secrets: z.array(SignetSecretView),
});
export type SignetProjectView = z.infer<typeof SignetProjectView>;

// One row of the hash-chained, append-only audit log.
export const SignetAuditEntry = z.object({
  seq: z.number().int(),
  ts: z.string(),
  actor: z.string(),
  action: z.string(),
  secret_id: z.string().optional(),
  target_id: z.string().optional(),
  details: z.string().optional(),
  prev_hash: z.string(),
  hash: z.string(),
});
export type SignetAuditEntry = z.infer<typeof SignetAuditEntry>;

// GET /v1/signet/summary
export const SignetSummary = z.object({
  secrets: z.number().int(),
  projects: z.number().int(),
  target_states: z.record(z.string(), z.number().int()),
  audit_entries: z.number().int(),
  chain_verified: z.boolean(),
});
export type SignetSummary = z.infer<typeof SignetSummary>;

// GET /v1/signet/secrets
export const SignetSecretsResponse = z.object({
  projects: z.array(SignetProjectView),
});
export type SignetSecretsResponse = z.infer<typeof SignetSecretsResponse>;

// GET /v1/signet/secrets/{project}/{name}
export const SignetSecretDetail = z.object({
  project: z.string(),
  secret: SignetSecretView.nullable(),
  audit: z.array(SignetAuditEntry),
});
export type SignetSecretDetail = z.infer<typeof SignetSecretDetail>;

// GET /v1/signet/audit
export const SignetAuditResponse = z.object({
  entries: z.array(SignetAuditEntry),
  chain_verified: z.boolean(),
  chain_length: z.number().int(),
  first_broken_seq: z.number().int(),
});
export type SignetAuditResponse = z.infer<typeof SignetAuditResponse>;

// GET /v1/signet/status — Switchyard-only liveness view (not a Signet route).
// `configured` = both SIGNET_API_URL and SIGNET_API_TOKEN are set; `reachable`
// = the daemon's /healthz answered. The admin UI's connection banner reads this
// as the single source of truth and degrades to "not connected" when false.
export const SignetStatus = z.object({
  configured: z.boolean(),
  reachable: z.boolean(),
  version: z.string().optional(),
  error: z.string().optional(),
});
export type SignetStatus = z.infer<typeof SignetStatus>;

// ── command bodies (issued to the daemon; the caller never touches values) ──

export const SignetSecretRef = z.object({
  project: z.string().min(1),
  name: z.string().min(1),
});
export type SignetSecretRef = z.infer<typeof SignetSecretRef>;

// POST /v1/signet/commands/sync and /rotate share the {project, name} body.
export const SignetSyncCommand = SignetSecretRef;
export type SignetSyncCommand = z.infer<typeof SignetSyncCommand>;

// POST /v1/signet/commands/add-target
export const SignetAddTargetCommand = SignetSecretRef.extend({
  repo: z.string().min(1),
  secret_name: z.string().optional(),
});
export type SignetAddTargetCommand = z.infer<typeof SignetAddTargetCommand>;

// POST /v1/signet/commands/set-expiry ("" clears the expiry).
export const SignetSetExpiryCommand = SignetSecretRef.extend({
  expires_at: z.string(),
});
export type SignetSetExpiryCommand = z.infer<typeof SignetSetExpiryCommand>;

// Command responses are daemon-shaped and only surfaced to the owner UI as an
// acknowledgement, so they're modeled loosely rather than mirrored field-for-
// field (the shapes vary per command and evolve with Signet).
export const SignetCommandResult = z.record(z.string(), z.unknown());
export type SignetCommandResult = z.infer<typeof SignetCommandResult>;
