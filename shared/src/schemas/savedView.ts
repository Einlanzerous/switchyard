import { z } from "zod";
import { Uuid, Iso8601 } from "./common.js";
import { UserRef } from "./user.js";

// ─── filter shape (mirrors useTicketFilters on the client) ─────────────────
//
// We keep this loose-ish (string arrays, no enum tightening) so the saved
// view doesn't break when we add a new ticket type or status category in
// the future. The client's parser is the source of truth for legal values.

export const SavedViewFilters = z.object({
  project: z.array(z.string()).default([]),
  status: z.array(z.string()).default([]),
  type: z.array(z.string()).default([]),
  priority: z.array(z.string()).default([]),
  assignee: z.string().nullable().optional(),
  text: z.string().nullable().optional(),
});
export type SavedViewFilters = z.infer<typeof SavedViewFilters>;

export const SavedViewScope = z.enum(["personal", "shared"]);
export type SavedViewScope = z.infer<typeof SavedViewScope>;

export const SavedView = z.object({
  id: Uuid,
  name: z.string().min(1).max(100),
  owner: UserRef,
  scope: SavedViewScope,
  filters: SavedViewFilters,
  created_at: Iso8601,
  updated_at: Iso8601,
});
export type SavedView = z.infer<typeof SavedView>;

export const CreateSavedView = z.object({
  name: z.string().min(1).max(100),
  scope: SavedViewScope.default("personal"),
  filters: SavedViewFilters,
});
export type CreateSavedView = z.infer<typeof CreateSavedView>;

export const UpdateSavedView = z.object({
  name: z.string().min(1).max(100).optional(),
  scope: SavedViewScope.optional(),
  filters: SavedViewFilters.optional(),
}).refine((b) => Object.keys(b).length > 0, "at least one field required");
export type UpdateSavedView = z.infer<typeof UpdateSavedView>;
