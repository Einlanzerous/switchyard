// Shared error helpers. Every switchyard endpoint returns
// `{ error: { code, message, details? } }` on failure — surface the
// code + message so the calling agent can act on it.

interface ApiErrorEnvelope {
  error?: {
    code?: string;
    message?: string;
    details?: Record<string, unknown>;
  };
}

export function formatApiError(err: unknown): string {
  const e = err as ApiErrorEnvelope;
  const code = e?.error?.code;
  const message = e?.error?.message;
  if (code || message) {
    return `switchyard error [${code ?? "unknown_error"}]: ${message ?? "(no message)"}`;
  }
  // Fallback: the response didn't match the standard `{ error: { code, message } }`
  // envelope. Rather than collapse to an opaque `unknown_error: (no message)`,
  // surface whatever shape arrived (a string, a zod `{ success, error }` body,
  // an empty body, …) so the caller has something actionable. (SWY-119)
  const summary =
    typeof err === "string"
      ? err
      : err == null
        ? "(empty response body)"
        : safeStringify(err);
  return `switchyard error [unknown_error]: ${summary}`;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
