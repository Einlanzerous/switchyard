import { z } from "zod";

export const Uuid = z.string().uuid();
export const Iso8601 = z.string().datetime({ offset: true });

export const ProjectKey = z
  .string()
  .regex(/^[A-Z][A-Z0-9]{1,9}$/, "1-10 chars, uppercase alphanumeric, must start with a letter");

export const TicketKey = z.string().regex(/^[A-Z][A-Z0-9]{1,9}-[1-9][0-9]*$/, "format: KEY-123");

export const HexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/);

// Cursor pagination — opaque base64-encoded payload from server.
export const Cursor = z.string().min(1);

export const Pagination = z.object({
  cursor: Cursor.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type Pagination = z.infer<typeof Pagination>;

export const PageMeta = z.object({
  next_cursor: z.string().nullable(),
  has_more: z.boolean(),
});
export type PageMeta = z.infer<typeof PageMeta>;

export function paginated<T extends z.ZodTypeAny>(item: T) {
  return z.object({
    items: z.array(item),
    page: PageMeta,
  });
}

// Structured error envelope. All non-2xx responses use this shape.
export const ErrorCode = z.enum([
  "bad_request",
  "unauthorized",
  "forbidden",
  "not_found",
  "conflict",
  "unprocessable",
  "rate_limited",
  "internal",
  "service_unavailable",
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const ErrorEnvelope = z.object({
  error: z.object({
    code: ErrorCode,
    message: z.string(),
    details: z.record(z.unknown()).optional(),
  }),
});
export type ErrorEnvelope = z.infer<typeof ErrorEnvelope>;

// Soft-delete timestamp shape on responses (always exposed for audit transparency).
export const Timestamps = z.object({
  created_at: Iso8601,
  updated_at: Iso8601,
});

export const SoftDeletable = Timestamps.extend({
  deleted_at: Iso8601.nullable(),
});

// Idempotency-Key header is required to be at most 128 chars; we don't validate
// its content, just that it's a sane length when present.
export const IdempotencyKey = z.string().min(1).max(128);
