import type { Context } from "hono";
import type { ErrorCode } from "@switchyard/shared";

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
  }
}

export const badRequest = (message: string, details?: Record<string, unknown>) =>
  new HttpError(400, "bad_request", message, details);
export const unauthorized = (message = "missing or invalid token") =>
  new HttpError(401, "unauthorized", message);
export const forbidden = (message = "insufficient scope") =>
  new HttpError(403, "forbidden", message);
export const notFound = (resource: string) =>
  new HttpError(404, "not_found", `${resource} not found`);
export const conflict = (message: string, details?: Record<string, unknown>) =>
  new HttpError(409, "conflict", message, details);
export const unprocessable = (message: string, details?: Record<string, unknown>) =>
  new HttpError(422, "unprocessable", message, details);
export const notImplemented = () =>
  new HttpError(501, "internal", "handler not yet implemented");

export function toEnvelope(err: unknown) {
  if (err instanceof HttpError) {
    return {
      status: err.status,
      body: {
        error: {
          code: err.code,
          message: err.message,
          ...(err.details ? { details: err.details } : {}),
        },
      },
    };
  }
  console.error("[switchyard] unexpected error:", err);
  return {
    status: 500,
    body: {
      error: {
        code: "internal" as const,
        message: "internal server error",
      },
    },
  };
}

export function installErrorHandler(app: { onError: (handler: any) => void }) {
  app.onError((err: unknown, c: Context) => {
    const { status, body } = toEnvelope(err);
    return c.json(body, status as any);
  });
}
