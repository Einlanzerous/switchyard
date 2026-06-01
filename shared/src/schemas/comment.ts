import { z } from "zod";
import { Uuid, SoftDeletable } from "./common.js";
import { UserRef } from "./user.js";
import { Attachment } from "./attachment.js";

export const Comment = z
  .object({
    id: Uuid,
    ticket_id: Uuid,
    author: UserRef,
    // For tombstoned comments the body is redacted server-side to a
    // "[deleted]" placeholder, so the min(1) floor still holds.
    body: z.string().min(1).max(50_000), // markdown
    attachments: z.array(Attachment),
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
