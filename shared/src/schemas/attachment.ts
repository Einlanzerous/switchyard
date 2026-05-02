import { z } from "zod";
import { Uuid, Iso8601 } from "./common.js";
import { UserRef } from "./user.js";

export const AttachmentKind = z.enum(["image", "audio", "text"]);
export type AttachmentKind = z.infer<typeof AttachmentKind>;

export const Attachment = z.object({
  id: Uuid,
  ticket_id: Uuid.nullable(),
  comment_id: Uuid.nullable(),
  kind: AttachmentKind,
  mime_type: z.string().max(200),
  size_bytes: z.number().int().nonnegative(),
  original_name: z.string().max(500).nullable(),
  // Server-side storage path is internal; clients see a URL.
  url: z.string().url(),
  // Audio attachments may carry a transcript supplied by the upstream pipeline.
  transcript: z.string().nullable(),
  uploaded_by: UserRef,
  created_at: Iso8601,
});
export type Attachment = z.infer<typeof Attachment>;

// Multipart upload form fields. Body validation happens at the Hono layer;
// this schema documents the contract.
export const CreateAttachmentForm = z.object({
  kind: AttachmentKind,
  transcript: z.string().optional(),
  comment_id: Uuid.optional(),
});
export type CreateAttachmentForm = z.infer<typeof CreateAttachmentForm>;
