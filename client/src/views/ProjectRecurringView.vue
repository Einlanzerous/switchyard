<script setup lang="ts">
// Per-project Recurring view (`/projects/:key/recurring`). Lists ticket
// templates (recurring + one-shot) for the project. Tab sibling of Board
// and Insights — same header chrome, swapped body.

import { computed, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/vue-query";
import {
  ArrowLeft, Plus, Repeat, Pencil, Trash2, Loader2, Play, Power,
} from "lucide-vue-next";
import { toast } from "vue-sonner";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import EmptyState from "@/components/EmptyState.vue";
import InsightsTabs from "@/components/dashboard/InsightsTabs.vue";
import TicketTemplateEditor from "@/components/templates/TicketTemplateEditor.vue";
import { api } from "@/lib/api";
import { queryKeys } from "@/lib/queryKeys";
import { formatRelativeTime } from "@/lib/formatTime";
import { useProjectStats } from "@/composables/useProjectStats";
import type { TicketTemplate } from "@switchyard/shared";

const route = useRoute();
const router = useRouter();
const qc = useQueryClient();

const projectKey = computed(() => {
  const v = route.params.key;
  return typeof v === "string" ? v : "";
});

const stats = useProjectStats(computed(() => projectKey.value || null));

const templatesQuery = useQuery({
  queryKey: computed(() => queryKeys.ticketTemplates(projectKey.value)),
  enabled: computed(() => projectKey.value.length > 0),
  queryFn: async () => {
    const { data, error } = await api.GET("/v1/projects/{key}/templates", {
      params: { path: { key: projectKey.value }, query: { limit: 200 } },
    });
    if (error) throw error;
    return data;
  },
});

const templates = computed<TicketTemplate[]>(
  () => (templatesQuery.data.value?.items ?? []) as TicketTemplate[],
);

// ─── editor dialog state ─────────────────────────────────────────────────
const editorOpen = ref(false);
const editing = ref<TicketTemplate | null>(null);

function openCreate() {
  editing.value = null;
  editorOpen.value = true;
}
function openEdit(t: TicketTemplate) {
  editing.value = t;
  editorOpen.value = true;
}

// ─── fire_now ────────────────────────────────────────────────────────────
const firingId = ref<string | null>(null);
const fireNowMut = useMutation({
  mutationFn: async (id: string) => {
    firingId.value = id;
    const { data, error } = await api.POST("/v1/templates/{id}/fire_now", {
      params: { path: { id } },
    });
    if (error) throw error;
    return data;
  },
  onSuccess: (data) => {
    qc.invalidateQueries({ queryKey: queryKeys.ticketTemplates(projectKey.value) });
    qc.invalidateQueries({ queryKey: queryKeys.tickets() });
    qc.invalidateQueries({ queryKey: queryKeys.projectBoard(projectKey.value) });
    if (data && "key" in data) toast.success(`Materialized ${data.key}`);
    else toast.success("Template fired");
  },
  onError: (err) => {
    const msg = (err as { error?: { message?: string } })?.error?.message ?? "Fire failed";
    toast.error(msg);
  },
  onSettled: () => { firingId.value = null; },
});

// ─── enable / disable toggle ─────────────────────────────────────────────
const toggleMut = useMutation({
  mutationFn: async (args: { id: string; enabled: boolean }) => {
    const { error } = await api.PATCH("/v1/templates/{id}", {
      params: { path: { id: args.id } },
      body: { enabled: args.enabled } as never,
    });
    if (error) throw error;
  },
  onSuccess: () => {
    qc.invalidateQueries({ queryKey: queryKeys.ticketTemplates(projectKey.value) });
  },
});

// ─── delete ──────────────────────────────────────────────────────────────
const confirmingId = ref<string | null>(null);
const deletingId = ref<string | null>(null);

const deleteMut = useMutation({
  mutationFn: async (id: string) => {
    deletingId.value = id;
    const { error } = await api.DELETE("/v1/templates/{id}", {
      params: { path: { id } },
    });
    if (error) throw error;
  },
  onSuccess: () => {
    qc.invalidateQueries({ queryKey: queryKeys.ticketTemplates(projectKey.value) });
    toast.success("Template deleted");
    confirmingId.value = null;
  },
  onError: (err) => {
    toast.error((err as { error?: { message?: string } })?.error?.message ?? "Delete failed");
  },
  onSettled: () => { deletingId.value = null; },
});

// ─── helpers ─────────────────────────────────────────────────────────────

// Human-readable schedule string. The full cron is in title attr if a user
// hovers — most callers want the gist.
function scheduleDescription(t: TicketTemplate): string {
  if (t.mode === "one_shot" && t.trigger_at) {
    const d = new Date(t.trigger_at);
    const dateStr = d.toLocaleDateString(undefined, { dateStyle: "medium" });
    return t.lead_days > 0
      ? `Once on ${dateStr} (fires ${t.lead_days}d ahead)`
      : `Once on ${dateStr}`;
  }
  if (!t.schedule_cron) return "—";
  // Heuristic friendly names for the preset cron strings; otherwise show raw.
  const c = t.schedule_cron;
  const tz = t.schedule_tz ? ` (${t.schedule_tz})` : "";
  if (c === "0 9 * * *") return `Daily at 9am${tz}`;
  if (c === "0 9 * * MON-FRI") return `Weekdays at 9am${tz}`;
  const weeklyMatch = c.match(/^0 9 \* \* ([0-6])$/);
  if (weeklyMatch) {
    const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    return `Every ${dayNames[Number(weeklyMatch[1])]} at 9am${tz}`;
  }
  const monthlyMatch = c.match(/^0 9 (\d+) \* \*$/);
  if (monthlyMatch) return `Monthly on day ${monthlyMatch[1]} at 9am${tz}`;
  return `${c}${tz}`;
}

// Precomputed display strings per template — derived from the templates
// array, so they don't get recomputed on every reactive tick (firingId /
// confirmingId / etc.). The fire-now / toggle paths invalidate the
// templates query, which refreshes this naturally.
const decoratedTemplates = computed(() =>
  templates.value.map((t) => ({
    template: t,
    scheduleDesc: scheduleDescription(t),
    lastFiredRel: formatRelativeTime(t.last_fired_at),
  })),
);

function back() { router.push("/projects"); }
</script>

<template>
  <div class="flex flex-col h-full">
    <!-- Header — same shell as ProjectBoardView / ProjectInsightsView. -->
    <div class="border-b bg-background/95 backdrop-blur sticky top-0 z-10">
      <div class="px-4 h-12 flex items-center gap-2">
        <Button variant="ghost" size="sm" class="h-8 -ml-2" @click="back">
          <ArrowLeft class="h-3.5 w-3.5 mr-1" /> Back
        </Button>
        <Separator orientation="vertical" class="h-5" />
        <span class="font-mono text-sm text-muted-foreground">{{ projectKey }}</span>
        <span v-if="stats.data.value?.project.name" class="text-muted-foreground/40">—</span>
        <span v-if="stats.data.value?.project.name" class="text-sm font-medium truncate">
          {{ stats.data.value.project.name }}
        </span>
        <Separator orientation="vertical" class="h-5" />
        <InsightsTabs
          :board-path="`/projects/${projectKey}/board`"
          :insights-path="`/projects/${projectKey}/insights`"
          :recurring-path="`/projects/${projectKey}/recurring`"
        />
        <div class="flex-1 min-w-0" />
        <Button size="sm" class="h-8" @click="openCreate">
          <Plus class="h-3.5 w-3.5 mr-1.5" /> New template
        </Button>
      </div>
    </div>

    <!-- Body -->
    <div class="flex-1 overflow-auto px-4 py-4 space-y-4">
      <div v-if="templatesQuery.isLoading.value" class="space-y-2">
        <Skeleton v-for="n in 3" :key="n" class="h-16 w-full" />
      </div>

      <EmptyState
        v-else-if="templates.length === 0"
        :icon="Repeat"
        title="No recurring templates yet"
        description="Templates materialize a ticket on schedule. Recurring uses cron; one-shot fires once at a target date (great for token-rotation reminders)."
      >
        <Button size="sm" @click="openCreate">
          <Plus class="h-3.5 w-3.5 mr-1.5" /> New template
        </Button>
      </EmptyState>

      <Card v-else>
        <CardContent class="p-0">
          <ul class="divide-y">
            <li
              v-for="{ template: t, scheduleDesc, lastFiredRel } in decoratedTemplates"
              :key="t.id"
              class="flex items-start gap-3 p-3"
            >
              <Repeat class="h-4 w-4 text-muted-foreground shrink-0 mt-1" />
              <div class="flex-1 min-w-0">
                <div class="flex items-center gap-2 flex-wrap">
                  <span class="font-medium text-sm">{{ t.title }}</span>
                  <span
                    class="text-[10px] uppercase tracking-wider rounded px-1.5 py-0.5"
                    :class="t.enabled
                      ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
                      : 'bg-muted text-muted-foreground'"
                  >
                    {{ t.enabled ? "Enabled" : "Disabled" }}
                  </span>
                  <span
                    class="text-[10px] uppercase tracking-wider rounded px-1.5 py-0.5 bg-muted text-muted-foreground"
                  >
                    {{ t.mode === "recurring" ? "Recurring" : "One-shot" }}
                  </span>
                </div>
                <div class="text-xs text-muted-foreground mt-0.5" :title="t.schedule_cron ?? t.trigger_at ?? ''">
                  {{ scheduleDesc }}
                </div>
                <div class="text-[11px] text-muted-foreground/80 mt-1">
                  Last fired: {{ lastFiredRel }}
                  <span v-if="t.due_date_offset_days != null" class="ml-3">
                    · Due offset: {{ t.due_date_offset_days }}d
                  </span>
                  <span class="ml-3">· Overlap: {{ t.overlap_policy }}</span>
                </div>
              </div>

              <!-- Actions: fire_now, enable toggle, edit, delete -->
              <div class="flex items-center gap-1 shrink-0">
                <Button
                  variant="ghost"
                  size="sm"
                  class="h-8"
                  :disabled="firingId === t.id || !t.enabled"
                  :title="t.enabled ? 'Fire now (does not advance schedule)' : 'Template is disabled'"
                  @click="fireNowMut.mutate(t.id)"
                >
                  <Loader2 v-if="firingId === t.id" class="h-3.5 w-3.5 animate-spin" />
                  <Play v-else class="h-3.5 w-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  class="h-8"
                  :title="t.enabled ? 'Disable' : 'Enable'"
                  @click="toggleMut.mutate({ id: t.id, enabled: !t.enabled })"
                >
                  <Power class="h-3.5 w-3.5" :class="t.enabled ? 'text-emerald-500' : 'text-muted-foreground'" />
                </Button>
                <Button variant="ghost" size="sm" class="h-8" @click="openEdit(t)">
                  <Pencil class="h-3.5 w-3.5" />
                </Button>

                <!-- Two-step delete confirm (matches pattern used elsewhere). -->
                <template v-if="confirmingId !== t.id">
                  <Button
                    variant="ghost"
                    size="sm"
                    class="h-8 text-muted-foreground hover:text-destructive"
                    @click="confirmingId = t.id"
                  >
                    <Trash2 class="h-3.5 w-3.5" />
                  </Button>
                </template>
                <template v-else>
                  <Button variant="ghost" size="sm" class="h-8" @click="confirmingId = null">
                    Cancel
                  </Button>
                  <Button
                    variant="destructive"
                    size="sm"
                    class="h-8"
                    :disabled="deletingId === t.id"
                    @click="deleteMut.mutate(t.id)"
                  >
                    <Loader2 v-if="deletingId === t.id" class="h-3.5 w-3.5 animate-spin mr-1" />
                    Confirm delete
                  </Button>
                </template>
              </div>
            </li>
          </ul>
        </CardContent>
      </Card>
    </div>

    <TicketTemplateEditor
      v-model:open="editorOpen"
      :project-key="projectKey"
      :template="editing"
    />
  </div>
</template>
