import { z } from "zod";

const Env = z.object({
  DATABASE_URL: z.string().url(),
  // Optional separate DB for tests. If unset, tests refuse to run rather than
  // touch the dev DB by accident.
  DATABASE_URL_TEST: z.string().url().optional(),

  PORT: z.coerce.number().int().positive().default(4002),
  PUBLIC_URL: z.string().url().default("http://localhost:4002"),
  UPLOAD_DIR: z.string().default("./uploads"),

  // Bootstrap token UX:
  //   - If BOOTSTRAP_TOKEN is set, that exact value is registered as an admin
  //     token attached to magos on first boot (idempotent).
  //   - If BOOTSTRAP_TOKEN is unset AND api_tokens is empty, one is auto-generated
  //     and surfaced via stdout + ${UPLOAD_DIR}/.bootstrap-token (one-shot file).
  BOOTSTRAP_TOKEN: z.string().min(8).optional(),

  // Attachment size caps. Defaults: image 25MB, audio 100MB, text 5MB.
  ATTACHMENT_MAX_IMAGE_BYTES: z.coerce.number().int().positive().default(25 * 1024 * 1024),
  ATTACHMENT_MAX_AUDIO_BYTES: z.coerce.number().int().positive().default(100 * 1024 * 1024),
  ATTACHMENT_MAX_TEXT_BYTES: z.coerce.number().int().positive().default(5 * 1024 * 1024),

  // Webhook dispatcher tuning.
  WEBHOOK_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  WEBHOOK_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  WEBHOOK_BATCH_SIZE: z.coerce.number().int().positive().default(32),

  // Rule dispatcher tuning. Lower retry ceiling than webhooks because action
  // failures are typically deterministic (a bad transition, a missing
  // assignee) — retrying just amplifies the noise. Admin redelivers
  // explicitly via POST /v1/rules/firings/{id}/redeliver.
  RULE_FIRING_MAX_ATTEMPTS: z.coerce.number().int().positive().default(3),
  RULE_BATCH_SIZE: z.coerce.number().int().positive().default(32),

  // Per-rule rate limit (Phase 4.1). Firings beyond this count in the
  // trailing hour are marked `skipped` with reason="rate_limited" instead
  // of executing. Catches runaway loops if a rule's condition is too
  // permissive on a wide event type.
  RULE_RATE_LIMIT_PER_HOUR: z.coerce.number().int().positive().default(100),

  // fire_webhook / call_n8n outbound timeout. Reuses the webhook
  // dispatcher's value by default; override independently when n8n is
  // slow and you don't want it to compete with subscription deliveries.
  RULE_WEBHOOK_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),

  // Base URL for call_n8n. The action prefixes this onto its `workflow`
  // path. Unset = call_n8n actions fail with a clear error at runtime.
  N8N_BASE_URL: z.string().url().optional(),

  // External ref polling (Phase 4.5.2). Unset GITHUB_TOKEN → polling
  // loop is a no-op (logs once at startup); attached refs still
  // display but state stays at whatever it was last polled to.
  GITHUB_TOKEN: z.string().min(8).optional(),
  EXTERNAL_REF_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(5 * 60_000),
  EXTERNAL_REF_POLL_BATCH_SIZE: z.coerce.number().int().positive().default(20),

  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
});

const parsed = Env.safeParse(process.env);
if (!parsed.success) {
  console.error("[switchyard] invalid environment:");
  for (const issue of parsed.error.issues) {
    console.error(`  ${issue.path.join(".")}: ${issue.message}`);
  }
  process.exit(1);
}

export const env = parsed.data;

export const ATTACHMENT_LIMITS = {
  image: env.ATTACHMENT_MAX_IMAGE_BYTES,
  audio: env.ATTACHMENT_MAX_AUDIO_BYTES,
  text: env.ATTACHMENT_MAX_TEXT_BYTES,
} as const;
