<script setup lang="ts">
import { ref, onMounted, computed } from "vue";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Activity, Database, FolderOpen, Webhook } from "lucide-vue-next";
import { useAuthStore } from "@/stores/auth";

const auth = useAuthStore();

type HealthReport = {
  status: "ok" | "degraded";
  subsystems: {
    db: { ok: boolean; latency_ms: number | null };
    uploads: { ok: boolean; dir: string };
    webhooks: { queue_depth: number; warn: boolean };
  };
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

const dbBadge = computed(() => health.value?.subsystems.db.ok ? "ok" : "down");
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
            <li class="flex items-center gap-2">
              <Database class="h-4 w-4 text-muted-foreground" />
              <span class="flex-1">Database</span>
              <Badge :variant="dbBadge === 'ok' ? 'secondary' : 'destructive'">
                {{ health.subsystems.db.ok ? `${health.subsystems.db.latency_ms}ms` : "down" }}
              </Badge>
            </li>
            <li class="flex items-center gap-2">
              <FolderOpen class="h-4 w-4 text-muted-foreground" />
              <span class="flex-1">Uploads</span>
              <Badge :variant="health.subsystems.uploads.ok ? 'secondary' : 'destructive'">
                {{ health.subsystems.uploads.ok ? "writable" : "fail" }}
              </Badge>
            </li>
            <li class="flex items-center gap-2">
              <Webhook class="h-4 w-4 text-muted-foreground" />
              <span class="flex-1">Webhook queue</span>
              <Badge :variant="health.subsystems.webhooks.warn ? 'destructive' : 'secondary'">
                {{ health.subsystems.webhooks.queue_depth }} pending
              </Badge>
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
            <li class="flex items-center gap-2">
              <span class="inline-block h-1.5 w-1.5 rounded-full bg-primary" />
              <span class="text-muted-foreground line-through">2.0 Foundations</span>
            </li>
            <li>2.1 Auth flow</li>
            <li>2.2 Tickets list</li>
            <li>2.3 Ticket detail (drawer)</li>
            <li>2.4 Kanban board</li>
            <li>2.5 Cross-project boards + swimlanes</li>
            <li>2.6 Settings</li>
            <li>2.7 Polish (cmd-K, shortcuts, empty states)</li>
          </ol>
        </CardContent>
      </Card>
    </div>
  </div>
</template>
