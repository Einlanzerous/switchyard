import { QueryClient } from "@tanstack/vue-query";
import { toast } from "vue-sonner";

// Decode the structured error envelope our API always returns:
//   { "error": { "code": "...", "message": "...", "details": {...} } }
// On non-Response errors fall back to the message field.
function describeError(err: unknown): string {
  if (!err) return "Unknown error";
  if (typeof err === "string") return err;
  // openapi-fetch surfaces the JSON body of error responses as the thrown value.
  const e = err as { error?: { message?: string }; message?: string };
  return e.error?.message ?? e.message ?? "Request failed";
}

export function createAppQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        gcTime: 5 * 60 * 1000,
        refetchOnWindowFocus: true,
        retry: (failureCount, err) => {
          // 4xx aren't retryable. The error shape from openapi-fetch is the
          // parsed JSON body when status >= 400, so we infer "client error"
          // by absence of a network-style message.
          if (failureCount >= 2) return false;
          const code = (err as any)?.error?.code as string | undefined;
          if (code && ["bad_request", "unauthorized", "forbidden", "not_found", "unprocessable", "conflict"].includes(code)) return false;
          return true;
        },
      },
      mutations: {
        // Mutations get a default error toast; success toasts live with the
        // caller because they're context-specific ("Ticket created", etc.).
        onError: (err) => {
          toast.error(describeError(err));
        },
      },
    },
  });
}
