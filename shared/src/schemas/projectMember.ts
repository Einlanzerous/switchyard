import { z } from "zod";
import { Uuid } from "./common.js";
import { UserRef } from "./user.js";
import { ProjectRole } from "./project.js";

// Phase 6.4 — per-project membership (a `user_projects` row joined to its user).
// `created_at` is the join timestamp (when the user was added to the project).
export const ProjectMember = z.object({
  user: UserRef,
  role: ProjectRole,
  created_at: z.string().datetime({ offset: true }),
});
export type ProjectMember = z.infer<typeof ProjectMember>;

export const AddProjectMember = z.object({
  user_id: Uuid,
  role: ProjectRole,
});
export type AddProjectMember = z.infer<typeof AddProjectMember>;

export const UpdateProjectMember = z.object({
  role: ProjectRole,
});
export type UpdateProjectMember = z.infer<typeof UpdateProjectMember>;
