import { z } from "zod";
import { Uuid, HexColor, Timestamps } from "./common.js";

// Labels are a single global catalog. They're not scoped to a project — any
// label can apply to any ticket, regardless of which project it lives in.
export const Label = z
  .object({
    id: Uuid,
    name: z.string().min(1).max(50),
    color: HexColor,
  })
  .merge(Timestamps);
export type Label = z.infer<typeof Label>;

export const LabelRef = Label.pick({ id: true, name: true, color: true });
export type LabelRef = z.infer<typeof LabelRef>;

export const CreateLabel = z.object({
  name: z.string().min(1).max(50),
  color: HexColor,
});
export type CreateLabel = z.infer<typeof CreateLabel>;

export const UpdateLabel = CreateLabel.partial();
export type UpdateLabel = z.infer<typeof UpdateLabel>;
