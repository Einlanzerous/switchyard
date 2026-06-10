import { z } from "zod";
import { Uuid, SoftDeletable, ProjectKey, HexColor } from "./common.js";
import { ClosedWindowDays } from "./settings.js";

// Project descriptions are a short blurb shown in the settings list and project
// header — not a doc. Cap kept tight (was 10k, which let a description balloon
// past the list view) so it word-clamps cleanly and the editor can surface a
// counter. Longest real description at the time of this cap was ~540 chars.
export const PROJECT_DESCRIPTION_MAX = 1_000;

// Per-project role carried on `user_projects.role` (Phase 6). viewer ⊂ editor ⊂
// admin: viewer reads, editor writes tickets/comments, admin manages project
// config + membership. Shared so both `my_role` and the membership endpoints
// reference one source of truth.
export const ProjectRole = z.enum(["admin", "editor", "viewer"]);
export type ProjectRole = z.infer<typeof ProjectRole>;

export const Project = z
  .object({
    id: Uuid,
    key: ProjectKey,
    name: z.string().min(1).max(200),
    description: z.string().max(PROJECT_DESCRIPTION_MAX).nullable(),
    color: HexColor.nullable(),
    // Canonical repo URL — surfaced as a link from the project header.
    // Loose `string().url()` validation; empty/null = no link.
    repo_url: z.string().url().max(2048).nullable(),
    // Default shell command pipeline-driven projects run for tickets
    // that don't carry their own `metadata.test_cmd`. Paired with
    // `repo_url` so the cogitation engine can pick up a project ticket
    // without per-ticket backfill.
    default_test_cmd: z.string().max(2048).nullable(),
    archived_at: z.string().datetime({ offset: true }).nullable(),
    // Per-project override for the kanban Closed column window. NULL =
    // inherit the system setting (`board_closed_window_days`). The
    // unions-with-null form (instead of `.nullable()`) is intentional —
    // zod-to-openapi emits a clean `anyOf [number, number, number, null]`
    // for this, whereas `.nullable()` on a union produces a poison-pill
    // `{ nullable: true }` entry that openapi-typescript reads as `unknown`.
    board_closed_window_days: z.union([
      z.literal(7), z.literal(14), z.literal(30), z.null(),
    ]),
    // The requesting caller's effective role on this project (Phase 6.4) —
    // `admin`/`editor`/`viewer` for a member, or `null` for an instance-wide
    // actor (owner/agent) who isn't gated by membership. Populated ONLY on the
    // single-project GET; list/ref responses omit it (hence `.optional()`),
    // since it's per-caller and a list would need a join per row. The client
    // gates the project Members tab on `my_role === 'admin' || isOwner`.
    my_role: ProjectRole.nullable().optional(),
  })
  .merge(SoftDeletable);
export type Project = z.infer<typeof Project>;

// Including repo_url here is intentional: project names render as repo
// links across every view that shows a ProjectRef (board headers, insights,
// recurring tab, drawer breadcrumb, etc.). The string is small and
// embedded everywhere is cheaper than a parallel project query per view.
export const ProjectRef = Project.pick({ id: true, key: true, name: true, color: true, repo_url: true });
export type ProjectRef = z.infer<typeof ProjectRef>;

export const CreateProject = z.object({
  key: ProjectKey, // immutable after creation
  name: z.string().min(1).max(200),
  description: z.string().max(PROJECT_DESCRIPTION_MAX).optional(),
  color: HexColor.optional(),
  repo_url: z.string().url().max(2048).optional(),
  default_test_cmd: z.string().max(2048).optional(),
  board_closed_window_days: ClosedWindowDays.optional(),
});
export type CreateProject = z.infer<typeof CreateProject>;

export const UpdateProject = CreateProject.omit({ key: true }).partial().extend({
  archived: z.boolean().optional(),
  // Allow null to clear the override and inherit from system again.
  board_closed_window_days: z.union([
    z.literal(7), z.literal(14), z.literal(30), z.null(),
  ]).optional(),
  // Null clears the repo_url link.
  repo_url: z.string().url().max(2048).nullable().optional(),
  // Null clears the default test command (tickets fall back to their own metadata).
  default_test_cmd: z.string().max(2048).nullable().optional(),
});
export type UpdateProject = z.infer<typeof UpdateProject>;
