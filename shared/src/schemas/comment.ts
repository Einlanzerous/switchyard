import { z } from "zod";
import { Uuid, SoftDeletable } from "./common.js";
import { UserRef } from "./user.js";
import { Attachment } from "./attachment.js";
import { PlanAnchor } from "./plan.js";

export const Comment = z
  .object({
    id: Uuid,
    ticket_id: Uuid,
    author: UserRef,
    // For tombstoned comments the body is redacted server-side to a
    // "[deleted]" placeholder, so the min(1) floor still holds.
    body: z.string().min(1).max(50_000), // markdown
    attachments: z.array(Attachment),
    // Plan threads (Phase 7). Set when the comment is anchored to a plan
    // revision; `plan_anchor` pins it within that revision. Both null/absent
    // for an ordinary ticket comment.
    plan_revision_id: Uuid.nullable().optional(),
    plan_anchor: PlanAnchor.nullable().optional(),
    // true when updated_at > created_at (server-derived).
    edited: z.boolean().optional(),
    // true when deleted_at is set; body is redacted and attachments dropped.
    deleted: z.boolean().optional(),
  })
  .merge(SoftDeletable);
export type Comment = z.infer<typeof Comment>;

export const CreateComment = z.object({
  body: z.string().min(1).max(50_000),
});
export type CreateComment = z.infer<typeof CreateComment>;

export const UpdateComment = CreateComment.partial();
export type UpdateComment = z.infer<typeof UpdateComment>;
