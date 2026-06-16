<script setup lang="ts">
// Admin → Observability (SWY-48 / 5.1.2). LLM-obs runtime settings (cost rate,
// retention, HITL thresholds) + the warn-list of unknown dimension values
// awaiting promote/reject.

import { computed, ref, watch } from "vue";
import { useMutation, useQuery, useQueryClient } from "@tanstack/vue-query";
import { Loader2 } from "lucide-vue-next";
import { toast } from "vue-sonner";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import { queryKeys } from "@/lib/queryKeys";
import { useLlmPendingValues, useResolvePendingValue } from "@/composables/useLlmInsights";

const qc = useQueryClient();

const settingsQuery = useQuery({
  queryKey: queryKeys.systemSettings(),
  queryFn: async () => {
    const { data, error } = await api.GET("/v1/settings", {});
    if (error) throw error;
    return data;
  },
});

const patch = useMutation({
  mutationFn: async (body: Record<string, number>) => {
    const { error } = await api.PATCH("/v1/settings", { body: body as never });
    if (error) throw error;
  },
  onSuccess: () => {
    qc.invalidateQueries({ queryKey: queryKeys.systemSettings() });
    toast.success("Observability settings updated");
  },
  onError: (e: Error) => toast.error(e.message ?? "Update failed"),
});

type NumKey =
  | "llm_obs_usd_per_kwh"
  | "llm_obs_retention_days"
  | "hitl_stall_in_progress_hours"
  | "hitl_stall_silent_hours";

function numField(key: NumKey, def: number) {
  const server = computed<number>(() => (settingsQuery.data.value?.[key] as number | undefined) ?? def);
  const local = ref(String(server.value));
  watch(server, (v) => { local.value = String(v); }, { immediate: true });
  const save = () => {
    const n = Number(local.value);
    if (Number.isFinite(n) && n !== server.value) patch.mutate({ [key]: n } as Record<string, number>);
  };
  return { local, save };
}

const kwh = numField("llm_obs_usd_per_kwh", 0.17);
const retention = numField("llm_obs_retention_days", 180);
const inProgress = numField("hitl_stall_in_progress_hours", 24);
const silent = numField("hitl_stall_silent_hours", 4);

// ── warn-list ────────────────────────────────────────────────────────────────
const showResolved = ref(false);
const pendingParams = computed(() => ({
  include_resolved: showResolved.value ? ("true" as const) : ("false" as const),
}));
const pending = useLlmPendingValues(pendingParams);
const items = computed(() => pending.data.value?.items ?? []);
const resolve = useResolvePendingValue();
</script>

<template>
  <div class="space-y-4">
    <header>
      <h2 class="text-xl font-semibold tracking-tight">Observability</h2>
      <p class="text-sm text-muted-foreground">
        LLM cost &amp; pipeline observability. Powers the
        <RouterLink to="/insights/llm" class="underline">LLM Insights</RouterLink> dashboards.
      </p>
    </header>

    <div v-if="settingsQuery.isLoading.value" class="space-y-3">
      <Skeleton class="h-40 w-full" />
    </div>

    <template v-else>
      <Card>
        <CardHeader>
          <CardTitle class="text-base">Cost &amp; retention</CardTitle>
          <CardDescription>
            Local (Ollama) calls are costed by energy: watts × latency × this
            rate. Raw observations are pruned after the retention window; daily
            rollups are kept forever.
          </CardDescription>
        </CardHeader>
        <CardContent class="space-y-3">
          <div class="flex items-center gap-3">
            <Label for="obs-kwh" class="shrink-0 w-52">Electricity rate ($/kWh)</Label>
            <Input
              id="obs-kwh" type="number" min="0" max="10" step="0.01"
              v-model="kwh.local.value" class="w-28"
              @blur="kwh.save"
            />
          </div>
          <div class="flex items-center gap-3">
            <Label for="obs-retention" class="shrink-0 w-52">Raw retention (days)</Label>
            <Input
              id="obs-retention" type="number" min="1" max="3650"
              v-model="retention.local.value" class="w-28"
              @blur="retention.save"
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle class="text-base">HITL stall detector</CardTitle>
          <CardDescription>
            Flag tickets in_progress longer than the first threshold with no LLM
            activity in the last of the second. Surfaces on the LLM Insights tab.
          </CardDescription>
        </CardHeader>
        <CardContent class="space-y-3">
          <div class="flex items-center gap-3">
            <Label for="obs-inprogress" class="shrink-0 w-52">In-progress threshold (h)</Label>
            <Input
              id="obs-inprogress" type="number" min="1" max="8760"
              v-model="inProgress.local.value" class="w-28"
              @blur="inProgress.save"
            />
          </div>
          <div class="flex items-center gap-3">
            <Label for="obs-silent" class="shrink-0 w-52">Silent threshold (h)</Label>
            <Input
              id="obs-silent" type="number" min="1" max="8760"
              v-model="silent.local.value" class="w-28"
              @blur="silent.save"
            />
            <span v-if="patch.isPending.value">
              <Loader2 class="h-3.5 w-3.5 animate-spin text-muted-foreground" />
            </span>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader class="flex-row items-center justify-between space-y-0">
          <div>
            <CardTitle class="text-base">Unknown values</CardTitle>
            <CardDescription>
              Service / operation / model / provider values seen in observations
              but not yet reviewed. Promote (known) or reject to clear them.
            </CardDescription>
          </div>
          <label class="flex items-center gap-1.5 text-xs text-muted-foreground shrink-0">
            <input type="checkbox" v-model="showResolved" /> Show resolved
          </label>
        </CardHeader>
        <CardContent>
          <div v-if="pending.isLoading.value" class="space-y-2">
            <div v-for="i in 3" :key="i" class="h-7 rounded bg-muted/40 animate-pulse" />
          </div>
          <div v-else-if="items.length === 0" class="py-6 text-center text-xs text-muted-foreground italic">
            Nothing pending — every dimension value is known.
          </div>
          <table v-else class="w-full text-sm">
            <thead>
              <tr class="text-[11px] uppercase tracking-wider text-muted-foreground">
                <th class="text-left font-medium pb-2">Dimension</th>
                <th class="text-left font-medium pb-2">Value</th>
                <th class="text-right font-medium pb-2">Seen</th>
                <th class="text-right font-medium pb-2 w-40">Action</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in items" :key="row.id" class="border-t">
                <td class="py-1.5 text-muted-foreground">{{ row.dimension }}</td>
                <td class="py-1.5 font-mono text-xs">{{ row.value }}</td>
                <td class="py-1.5 text-right tabular-nums text-muted-foreground">{{ row.observation_count }}</td>
                <td class="py-1.5 text-right">
                  <span
                    v-if="row.resolved_at"
                    class="text-xs"
                    :class="row.resolution === 'promoted' ? 'text-emerald-600 dark:text-emerald-500' : 'text-muted-foreground'"
                  >{{ row.resolution }}</span>
                  <span v-else class="inline-flex gap-1.5">
                    <Button
                      size="sm" variant="outline" class="h-6 px-2 text-xs"
                      :disabled="resolve.isPending.value"
                      @click="resolve.mutate({ id: row.id, action: 'promote' })"
                    >Promote</Button>
                    <Button
                      size="sm" variant="ghost" class="h-6 px-2 text-xs text-muted-foreground"
                      :disabled="resolve.isPending.value"
                      @click="resolve.mutate({ id: row.id, action: 'reject' })"
                    >Reject</Button>
                  </span>
                </td>
              </tr>
            </tbody>
          </table>
        </CardContent>
      </Card>
    </template>
  </div>
</template>
