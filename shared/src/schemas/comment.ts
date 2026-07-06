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
  // Plan threads (Phase 7.1). Anchor a new comment to a plan revision, and
  // optionally to a sub-target within it via `plan_anchor`. A `plan_anchor`
  // requires `plan_revision_id` (mirrors the comments_plan_anchor_requires_revision
  // CHECK); the create handler additionally validates the revision belongs to
  // this ticket's plan and that a `criterion:<id>` anchor names a real criterion
  // in that revision. Both absent → an ordinary ticket comment. The anchor is
  // immutable after creation, so it is not editable via UpdateComment.
  plan_revision_id: Uuid.optional(),
  plan_anchor: PlanAnchor.optional(),
});
export type CreateComment = z.infer<typeof CreateComment>;

// Edits only ever touch the body — a comment's plan anchor is fixed at creation.
export const UpdateComment = z.object({
  body: z.string().min(1).max(50_000).optional(),
});
export type UpdateComment = z.infer<typeof UpdateComment>;
