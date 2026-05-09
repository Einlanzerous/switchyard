<script setup lang="ts">
// System health admin page. Re-renders /healthz in a real page rather than
// the prior home-card. Reserved layout for future Aperture pending-work
// widget — that lands when we wire the construct-server cross-stack view.

import { ref, onMounted, computed } from "vue";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { HeartPulse, Database, FolderOpen, Webhook, AlertCircle } from "lucide-vue-next";

// Same defensive shape as the old home card — old container builds (pre-1.6)
// returned a flatter object; both render usefully here.
type HealthReport = {
  status: "ok" | "degraded";
  subsystems?: {
    db?: { ok: boolean; latency_ms: number | null };
    uploads?: { ok: boolean; dir: string };
    webhooks?: { queue_depth: number; warn: boolean };
  };
  db?: boolean;
};

const health = ref<HealthReport | null>(null);
const error = ref<string | null>(null);

async function refresh() {
  error.value = null;
  try {
    const res = await fetch("/healthz");
    health.value = await res.json();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}
onMounted(refresh);

const db = computed(() => {
  const sub = health.value?.subsystems?.db;
  if (sub) return { ok: sub.ok, label: sub.ok ? `${sub.latency_ms}ms` : "down" };
  if (typeof health.value?.db === "boolean") {
    return { ok: health.value.db, label: health.value.db ? "ok" : "down" };
  }
  return null;
});
const uploads = computed(() => health.value?.subsystems?.uploads ?? null);
const webhooks = computed(() => health.value?.subsystems?.webhooks ?? null);

const overallStatus = computed(() => health.value?.status ?? "unknown");
</script>

<template>
  <div class="px-6 py-6 max-w-5xl mx-auto space-y-5">
    <header class="flex items-end justify-between gap-3">
      <div>
        <h1 class="text-2xl font-semibold tracking-tight flex items-center gap-2">
          <HeartPulse class="h-5 w-5 text-muted-foreground" /> Health
        </h1>
        <p class="mt-1 text-sm text-muted-foreground">
          Live probe of the running container's subsystems.
        </p>
      </div>
      <Badge
        :variant="overallStatus === 'ok' ? 'secondary' : overallStatus === 'degraded' ? 'destructive' : 'outline'"
      >
        {{ overallStatus }}
      </Badge>
    </header>

    <Card>
      <CardHeader>
        <CardTitle class="text-base">Subsystems</CardTitle>
        <CardDescription>Pulled from <code class="text-xs">/healthz</code> on page load.</CardDescription>
      </CardHeader>
      <CardContent>
        <div v-if="!health && !error" class="space-y-2">
          <Skeleton class="h-5 w-40" />
          <Skeleton class="h-5 w-56" />
          <Skeleton class="h-5 w-32" />
        </div>
        <div v-else-if="error" class="flex items-center gap-2 text-sm text-destructive">
          <AlertCircle class="h-4 w-4" />
          <span class="font-mono">{{ error }}</span>
        </div>
        <ul v-else-if="health" class="space-y-2 text-sm">
          <li v-if="db" class="flex items-center gap-2">
            <Database class="h-4 w-4 text-muted-foreground" />
            <span class="flex-1">Database</span>
            <Badge :variant="db.ok ? 'secondary' : 'destructive'">{{ db.label }}</Badge>
          </li>
          <li v-if="uploads" class="flex items-center gap-2">
            <FolderOpen class="h-4 w-4 text-muted-foreground" />
            <span class="flex-1">Uploads</span>
            <Badge :variant="uploads.ok ? 'secondary' : 'destructive'">
              {{ uploads.ok ? "writable" : "fail" }}
            </Badge>
          </li>
          <li v-if="webhooks" class="flex items-center gap-2">
            <Webhook class="h-4 w-4 text-muted-foreground" />
            <span class="flex-1">Webhook queue</span>
            <Badge :variant="webhooks.warn ? 'destructive' : 'secondary'">
              {{ webhooks.queue_depth }} pending
            </Badge>
          </li>
          <li v-if="!uploads && !webhooks" class="text-xs text-muted-foreground italic">
            Older API shape — rebuild the container for the full subsystem report.
          </li>
        </ul>
      </CardContent>
    </Card>

    <!-- Reserved: future Aperture pending-work widget will land here once
         the cross-stack integration is wired up. Documented in PHASES.md
         under the 3.1 Health-page section. -->
    <Card class="border-dashed">
      <CardHeader>
        <CardTitle class="text-base text-muted-foreground">Stack health (coming soon)</CardTitle>
        <CardDescription>
          Wider construct-server status — Aperture pending work, n8n queue depth, recent errors.
        </CardDescription>
      </CardHeader>
    </Card>
  </div>
</template>
