import { z } from "zod";
import { Uuid, SoftDeletable, ProjectKey, HexColor } from "./common.js";
import { ClosedWindowDays } from "./settings.js";

export const Project = z
  .object({
    id: Uuid,
    key: ProjectKey,
    name: z.string().min(1).max(200),
    description: z.string().max(10_000).nullable(),
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
  description: z.string().max(10_000).optional(),
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
