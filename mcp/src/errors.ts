// Shared error helpers. Every switchyard endpoint returns
// `{ error: { code, message, details? } }` on failure — surface the
// code + message so the calling agent can act on it.

export interface ApiErrorEnvelope {
  error?: {
    code?: string;
    message?: string;
    details?: Record<string, unknown>;
  };
}

export function formatApiError(err: unknown): string {
  const e = err as ApiErrorEnvelope;
  const code = e?.error?.code ?? "unknown_error";
  const message = e?.error?.message ?? "(no message)";
  return `switchyard error [${code}]: ${message}`;
}
