import { z } from "zod";

export const Uuid = z.string().uuid();
export const Iso8601 = z.string().datetime({ offset: true });

export const ProjectKey = z
  .string()
  .regex(/^[A-Z][A-Z0-9]{1,9}$/, "1-10 chars, uppercase alphanumeric, must start with a letter");

export const TicketKey = z.string().regex(/^[A-Z][A-Z0-9]{1,9}-[1-9][0-9]*$/, "format: KEY-123");

// Hex color with a relative-luminance guard: rejects values too close to the
// app's light or dark theme backgrounds so projects + labels stay visible on
// both themes. Bounds (0.08–0.9) are a WCAG-flavored heuristic, not the strict
// 4.5:1 contrast spec — we only need to keep the swatch distinguishable from
// the surface it sits on, not pass-against-text.
export const LUMINANCE_LOWER = 0.08;
export const LUMINANCE_UPPER = 0.9;

function relativeLuminance(hex: string): number {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const channel = (c: number) =>
    c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function isContrastSafe(hex: string): boolean {
  const L = relativeLuminance(hex);
  return L >= LUMINANCE_LOWER && L <= LUMINANCE_UPPER;
}

export const HexColor = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, "Color must be a 6-digit hex like #3b82f6.")
  .refine(isContrastSafe, {
    message: `Color is too close to a theme background; pick a value with relative luminance between ${LUMINANCE_LOWER} and ${LUMINANCE_UPPER}.`,
  });

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
