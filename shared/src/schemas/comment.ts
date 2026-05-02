import { z } from "zod";
import { Uuid, SoftDeletable } from "./common.js";
import { UserRef } from "./user.js";
import { Attachment } from "./attachment.js";

export const Comment = z
  .object({
    id: Uuid,
    ticket_id: Uuid,
    author: UserRef,
    body: z.string().min(1).max(50_000), // markdown
    attachments: z.array(Attachment),
  })
  .merge(SoftDeletable);
export type Comment = z.infer<typeof Comment>;

export const CreateComment = z.object({
  body: z.string().min(1).max(50_000),
});
export type CreateComment = z.infer<typeof CreateComment>;

export const UpdateComment = CreateComment.partial();
export type UpdateComment = z.infer<typeof UpdateComment>;
