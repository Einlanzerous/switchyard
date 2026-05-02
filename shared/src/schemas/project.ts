import { z } from "zod";
import { Uuid, SoftDeletable, ProjectKey, HexColor } from "./common.js";

export const Project = z
  .object({
    id: Uuid,
    key: ProjectKey,
    name: z.string().min(1).max(200),
    description: z.string().max(10_000).nullable(),
    color: HexColor.nullable(),
    archived_at: z.string().datetime({ offset: true }).nullable(),
  })
  .merge(SoftDeletable);
export type Project = z.infer<typeof Project>;

export const ProjectRef = Project.pick({ id: true, key: true, name: true, color: true });
export type ProjectRef = z.infer<typeof ProjectRef>;

export const CreateProject = z.object({
  key: ProjectKey, // immutable after creation
  name: z.string().min(1).max(200),
  description: z.string().max(10_000).optional(),
  color: HexColor.optional(),
});
export type CreateProject = z.infer<typeof CreateProject>;

export const UpdateProject = CreateProject.omit({ key: true }).partial().extend({
  archived: z.boolean().optional(),
});
export type UpdateProject = z.infer<typeof UpdateProject>;
