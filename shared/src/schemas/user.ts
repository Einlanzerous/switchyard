import { z } from "zod";
import { Uuid, SoftDeletable } from "./common.js";

export const UserType = z.enum(["agent", "human"]);
export type UserType = z.infer<typeof UserType>;

// Instance-wide role (Phase 6). `owner` = magos: blanket cross-project access.
// `member` = a scoped human who sees only the projects they're a member of.
// Agents bypass this entirely (instance-wide service accounts) regardless of
// the column value. Backfilled by migration 0019.
export const InstanceRole = z.enum(["owner", "member"]);
export type InstanceRole = z.infer<typeof InstanceRole>;

export const User = z
  .object({
    id: Uuid,
    name: z.string().min(1).max(100),
    icon: z.string().max(500).nullable(),
    type: UserType,
    instance_role: InstanceRole,
    // Lowercased; unique among non-deleted users. Matched against the verified
    // Cloudflare Access `email` claim for SSO (SWY-161).
    email: z.string().nullable(),
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
  // Optional on create — defaults to `member` server-side. Invited humans are
  // members; promoting to owner is a deliberate later action.
  instance_role: InstanceRole.optional(),
  email: z.string().email().max(255).optional(),
});
export type CreateUser = z.infer<typeof CreateUser>;

// email is nullable on update so an admin can clear it (disables SSO for the user).
export const UpdateUser = CreateUser.partial().extend({
  email: z.string().email().max(255).nullable().optional(),
});
export type UpdateUser = z.infer<typeof UpdateUser>;
