<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useMutation, useQuery, useQueryClient } from "@tanstack/vue-query";
import { Loader2 } from "lucide-vue-next";
import { toast } from "vue-sonner";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import { queryKeys } from "@/lib/queryKeys";

const qc = useQueryClient();

const settingsQuery = useQuery({
  queryKey: queryKeys.systemSettings(),
  queryFn: async () => {
    const { data, error } = await api.GET("/v1/settings", {});
    if (error) throw error;
    return data;
  },
});

const closedWindow = computed<number>(() => {
  const v = settingsQuery.data.value?.board_closed_window_days;
  return typeof v === "number" ? v : 14;
});

const staleDays = computed<number>(() => {
  return settingsQuery.data.value?.stale_in_progress_days ?? 30;
});

// Local mirror so the <Input> v-models a string the user can edit freely.
// We seed it from `staleDays` and reconcile on server-side change (e.g. after
// save success the computed value updates → we re-seed). Without this the
// input shows up empty because shadcn-vue's Input uses v-model, not :value.
const staleDaysInput = ref<string>(String(staleDays.value));
watch(staleDays, (v) => {
  staleDaysInput.value = String(v);
}, { immediate: true });

const closedWindowMutation = useMutation({
  mutationFn: async (raw: string) => {
    const next = Number(raw) as 7 | 14 | 30;
    const { error } = await api.PATCH("/v1/settings", {
      body: { board_closed_window_days: next as never },
    });
    if (error) throw error;
  },
  onSuccess: () => {
    qc.invalidateQueries({ queryKey: queryKeys.systemSettings() });
    toast.success("System settings updated");
  },
});

const staleDaysMutation = useMutation({
  mutationFn: async (raw: string) => {
    const next = Number(raw);
    if (!Number.isInteger(next) || next < 1 || next > 3650) {
      throw new Error("must be an integer 1..3650");
    }
    const { error } = await api.PATCH("/v1/settings", {
      body: { stale_in_progress_days: next as never },
    });
    if (error) throw error;
  },
  onSuccess: () => {
    qc.invalidateQueries({ queryKey: queryKeys.systemSettings() });
    toast.success("System settings updated");
  },
  onError: (err: Error) => {
    toast.error(err.message ?? "Update failed");
  },
});
</script>

<template>
  <div class="space-y-4">
    <header>
      <h2 class="text-xl font-semibold tracking-tight">System</h2>
      <p class="text-sm text-muted-foreground">
        Runtime-tunable globals. Per-project overrides live on each project's
        settings page.
      </p>
    </header>

    <div v-if="settingsQuery.isLoading.value" class="space-y-3">
      <Skeleton class="h-32 w-full" />
    </div>

    <template v-else>
      <Card>
        <CardHeader>
          <CardTitle class="text-base">Board</CardTitle>
          <CardDescription>
            How the kanban Closed column behaves by default. Per-project
            overrides can shorten or extend this window for individual
            projects.
          </CardDescription>
        </CardHeader>
        <CardContent class="space-y-2">
          <div class="flex items-center gap-3">
            <Label for="sys-closed-window" class="shrink-0 w-44">Closed column window</Label>
            <select
              id="sys-closed-window"
              :value="String(closedWindow)"
              class="rounded-md border bg-background px-2 py-1.5 text-sm"
              @change="(e) => closedWindowMutation.mutate((e.target as HTMLSelectElement).value)"
            >
              <option value="7">7 days</option>
              <option value="14">14 days</option>
              <option value="30">30 days</option>
            </select>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle class="text-base">Stats</CardTitle>
          <CardDescription>
            Thresholds that feed the per-project Insights and the homepage
            stale-work widget.
          </CardDescription>
        </CardHeader>
        <CardContent class="space-y-2">
          <div class="flex items-center gap-3">
            <Label for="sys-stale-days" class="shrink-0 w-44">Stale in-progress (days)</Label>
            <Input
              id="sys-stale-days"
              type="number"
              min="1"
              max="3650"
              v-model="staleDaysInput"
              class="w-24 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
              @blur="() => {
                if (staleDaysInput !== String(staleDays)) staleDaysMutation.mutate(staleDaysInput);
              }"
            />
            <span class="text-xs text-muted-foreground">days</span>
            <span v-if="staleDaysMutation.isPending.value">
              <Loader2 class="h-3.5 w-3.5 animate-spin text-muted-foreground" />
            </span>
          </div>
          <p class="text-xs text-muted-foreground">
            A ticket in_progress beyond this many days counts as "stale" in
            the dashboard widgets and per-project stats.
          </p>
        </CardContent>
      </Card>
    </template>
  </div>
</template>
