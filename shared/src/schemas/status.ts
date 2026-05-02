import { z } from "zod";
import { Uuid, Timestamps } from "./common.js";

export const StatusCategory = z.enum([
  "backlog",
  "planning",
  "in_progress",
  "blocked",
  "closed",
]);
export type StatusCategory = z.infer<typeof StatusCategory>;

export const Resolution = z.enum(["done", "released", "cancelled"]);
export type Resolution = z.infer<typeof Resolution>;

export const Status = z
  .object({
    id: Uuid,
    project_id: Uuid,
    category: StatusCategory,
    display_name: z.string().min(1).max(50),
    position: z.number().int().min(0),
    is_default: z.boolean(),
  })
  .merge(Timestamps);
export type Status = z.infer<typeof Status>;

export const StatusRef = Status.pick({
  id: true,
  category: true,
  display_name: true,
});
export type StatusRef = z.infer<typeof StatusRef>;

export const CreateStatus = z.object({
  category: StatusCategory,
  display_name: z.string().min(1).max(50),
  position: z.number().int().min(0).optional(),
  is_default: z.boolean().optional(),
});
export type CreateStatus = z.infer<typeof CreateStatus>;

export const UpdateStatus = CreateStatus.partial();
export type UpdateStatus = z.infer<typeof UpdateStatus>;

export const ReorderStatuses = z.object({
  status_ids: z.array(Uuid).min(1),
});
export type ReorderStatuses = z.infer<typeof ReorderStatuses>;
