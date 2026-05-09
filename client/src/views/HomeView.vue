<script setup lang="ts">
import { ref, onMounted, computed } from "vue";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Activity, Database, FolderOpen, Webhook, CheckCircle2, Circle } from "lucide-vue-next";
import { useAuthStore } from "@/stores/auth";

const auth = useAuthStore();

// Update `done: true` as each milestone ships. Keeps the roadmap card honest
// without per-card edits.
const milestones: Array<{ id: string; label: string; done: boolean }> = [
  { id: "2.0", label: "Foundations", done: true },
  { id: "2.1", label: "Auth flow", done: true },
  { id: "2.2", label: "Tickets list", done: true },
  { id: "2.3", label: "Ticket detail (drawer + page)", done: true },
  { id: "2.4", label: "Kanban board", done: true },
  { id: "2.5", label: "Cross-project boards + swimlanes", done: true },
  { id: "2.6", label: "Settings", done: false },
  { id: "2.7", label: "Polish (cmd-K, shortcuts, empty states)", done: false },
];

// Defensive: older container builds (pre-1.6) returned `{ status, db }` instead
// of the subsystems block. Treat both shapes uniformly so the dashboard renders
// regardless of which build is running.
type HealthReport = {
  status: "ok" | "degraded";
  subsystems?: {
    db?: { ok: boolean; latency_ms: number | null };
    uploads?: { ok: boolean; dir: string };
    webhooks?: { queue_depth: number; warn: boolean };
  };
  // Pre-1.6 shape — kept so old containers still render usefully.
  db?: boolean;
};

const health = ref<HealthReport | null>(null);
const error = ref<string | null>(null);

onMounted(async () => {
  try {
    const res = await fetch("/healthz");
    health.value = await res.json();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
});

// Normalize across the old and new shapes.
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
</script>

<template>
  <div class="container py-10 max-w-5xl">
    <div class="mb-8">
      <h1 class="text-3xl font-semibold tracking-tight">
        Welcome{{ auth.me?.name ? `, ${auth.me.name}` : "" }}
      </h1>
      <p class="mt-1 text-sm text-muted-foreground">
        Phase 2 scaffold — real views land milestone by milestone.
      </p>
    </div>

    <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
      <Card>
        <CardHeader>
          <CardTitle class="text-base flex items-center gap-2">
            <Activity class="h-4 w-4" /> System health
          </CardTitle>
          <CardDescription>Live probe of /healthz subsystems.</CardDescription>
        </CardHeader>
        <CardContent>
          <div v-if="!health && !error" class="space-y-2">
            <Skeleton class="h-4 w-32" />
            <Skeleton class="h-4 w-44" />
            <Skeleton class="h-4 w-28" />
          </div>
          <p v-else-if="error" class="text-sm text-destructive font-mono">{{ error }}</p>
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

      <Card>
        <CardHeader>
          <CardTitle class="text-base">Roadmap</CardTitle>
          <CardDescription>Milestones for this phase.</CardDescription>
        </CardHeader>
        <CardContent>
          <ol class="space-y-1.5 text-sm">
            <li
              v-for="m in milestones"
              :key="m.id"
              class="flex items-center gap-2"
              :class="m.done && 'text-muted-foreground'"
            >
              <CheckCircle2 v-if="m.done" class="h-3.5 w-3.5 text-emerald-500 shrink-0" />
              <Circle v-else class="h-3.5 w-3.5 text-muted-foreground/40 shrink-0" />
              <span :class="m.done && 'line-through'">{{ m.id }} {{ m.label }}</span>
            </li>
          </ol>
        </CardContent>
      </Card>
    </div>
  </div>
</template>
