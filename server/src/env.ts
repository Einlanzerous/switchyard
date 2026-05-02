import { z } from "zod";

const Env = z.object({
  DATABASE_URL: z.string().url(),
  PORT: z.coerce.number().int().positive().default(4002),
  PUBLIC_URL: z.string().url().default("http://localhost:4002"),
  UPLOAD_DIR: z.string().default("./uploads"),
  // Optional: surfaces a one-time admin token in the logs on first boot if no api_tokens exist.
  BOOTSTRAP_TOKEN: z.string().optional(),
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
