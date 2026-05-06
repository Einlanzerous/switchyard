// /healthz subsystem probes. Each probe is independent; any failure surfaces
// the overall status as `degraded` and the response code becomes 503 so
// orchestrators (docker, uptime kuma, n8n monitors) can react.
import { unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { sql, inArray } from "drizzle-orm";
import { db, schema, pingDatabase } from "../db.js";
import { env } from "../env.js";

export type SubsystemStatus = {
  db: { ok: boolean; latency_ms: number | null };
  uploads: { ok: boolean; dir: string };
  webhooks: { queue_depth: number; warn: boolean };
};

export type HealthReport = {
  status: "ok" | "degraded";
  subsystems: SubsystemStatus;
};

const QUEUE_WARN_THRESHOLD = 1000;

export async function probeDb(): Promise<{ ok: boolean; latency_ms: number | null }> {
  const start = performance.now();
  const ok = await pingDatabase();
  const latency_ms = ok ? Math.round(performance.now() - start) : null;
  return { ok, latency_ms };
}

export async function probeUploads(): Promise<{ ok: boolean; dir: string }> {
  const dir = resolve(env.UPLOAD_DIR);
  const probePath = resolve(dir, ".healthz-probe");
  try {
    await Bun.write(probePath, "ok");
    await unlink(probePath);
    return { ok: true, dir };
  } catch {
    return { ok: false, dir };
  }
}

export async function probeWebhookQueue(): Promise<{ queue_depth: number; warn: boolean }> {
  try {
    const rows = await db.select({ count: sql<number>`count(*)::int` })
      .from(schema.webhookDeliveries)
      .where(inArray(schema.webhookDeliveries.status, ["pending", "failed"]));
    const queue_depth = rows[0]?.count ?? 0;
    return { queue_depth, warn: queue_depth > QUEUE_WARN_THRESHOLD };
  } catch {
    return { queue_depth: -1, warn: true };
  }
}

export async function buildHealthReport(): Promise<HealthReport> {
  const [dbS, uploadsS, webhooksS] = await Promise.all([
    probeDb(),
    probeUploads(),
    probeWebhookQueue(),
  ]);
  const allOk = dbS.ok && uploadsS.ok && webhooksS.queue_depth >= 0;
  return {
    status: allOk ? "ok" : "degraded",
    subsystems: { db: dbS, uploads: uploadsS, webhooks: webhooksS },
  };
}
