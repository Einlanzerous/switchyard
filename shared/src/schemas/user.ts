import { z } from "zod";
import { Uuid, SoftDeletable } from "./common.js";

export const UserType = z.enum(["agent", "human"]);
export type UserType = z.infer<typeof UserType>;

export const User = z
  .object({
    id: Uuid,
    name: z.string().min(1).max(100),
    icon: z.string().max(500).nullable(),
    type: UserType,
  })
  .merge(SoftDeletable);
export type User = z.infer<typeof User>;

// Embedded shape used in webhook payloads, comment authors, etc. — no timestamps.
export const UserRef = User.pick({ id: true, name: true, icon: true, type: true });
export type UserRef = z.infer<typeof UserRef>;

export const CreateUser = z.object({
  name: z.string().min(1).max(100),
  icon: z.string().max(500).optional(),
  type: UserType,
});
export type CreateUser = z.infer<typeof CreateUser>;

export const UpdateUser = CreateUser.partial();
export type UpdateUser = z.infer<typeof UpdateUser>;
