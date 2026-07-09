import type { Context } from "hono";
import type { ErrorCode } from "@switchyard/shared";

class HttpError extends Error {
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

// Cloudflare Access SSO (SWY-161). `ssoDisabled` = env not configured or the
// Cf-Access-Jwt-Assertion header is absent (401, so the login page falls back
// to token paste). `ssoNoAccount` = the JWT verified but no live user has that
// email; the email is echoed in details so the client can name it.
export const ssoDisabled = (message = "Cloudflare Access SSO is not available") =>
  new HttpError(401, "sso_disabled", message);
export const ssoNoAccount = (email: string) =>
  new HttpError(
    403,
    "sso_no_account",
    `signed in to Cloudflare as ${email}, but no switchyard account has that email`,
    { email },
  );

// Wrap an INSERT/UPDATE that may fail with a Postgres unique-constraint
// violation. Translates the 23505 SQLSTATE into a friendly 409 with the
// caller's message; lets every other error propagate.
export async function catchUnique<T>(message: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err: any) {
    // Drizzle wraps the underlying pg error, so the 23505 SQLSTATE can live on
    // the wrapper *or* on `.cause`. Check both so a unique violation always
    // becomes a clean 409 instead of falling through to a generic 500.
    if (err?.code === "23505" || err?.cause?.code === "23505") throw conflict(message);
    throw err;
  }
}

// OpenAPIHono `defaultHook` — runs after every request-validation pass. On
// failure, zod-openapi would otherwise emit its own `{ success, error }` body,
// which does NOT match our `{ error: { code, message } }` contract. Callers
// that key off that contract (the MCP server's formatApiError) then surface it
// as `unknown_error: (no message)`. Convert validation failures into the
// standard 400 envelope, naming the first failing field and carrying the full
// issue list in `details` so the caller knows exactly what to fix. (SWY-119)
export function validationHook(
  result: { success: boolean; error?: { issues?: Array<{ path?: Array<string | number>; message?: string }> } },
  c: Context,
) {
  if (result.success) return;
  const issues = result.error?.issues ?? [];
  const first = issues[0];
  const where = first?.path && first.path.length > 0 ? first.path.join(".") : "(body)";
  const message = first?.message ? `${where}: ${first.message}` : "request validation failed";
  return c.json(
    { error: { code: "bad_request" as ErrorCode, message, details: { issues } } },
    400,
  );
}

function toEnvelope(err: unknown) {
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
