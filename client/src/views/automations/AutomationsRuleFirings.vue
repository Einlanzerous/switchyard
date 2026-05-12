<script setup lang="ts">
import { computed, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/vue-query";
import {
  ArrowLeft, Loader2, RefreshCw, CheckCircle2, XCircle, Clock, AlertCircle, Inbox,
  CircleSlash, Play,
} from "lucide-vue-next";
import { formatDistanceToNow } from "date-fns";
import { toast } from "vue-sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import EmptyState from "@/components/EmptyState.vue";
import {
  Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle,
} from "@/components/ui/sheet";
import { api } from "@/lib/api";
import { queryKeys } from "@/lib/queryKeys";
import type { RuleFiring, RuleFiringStatus } from "@switchyard/shared";

const route = useRoute();
const router = useRouter();
const qc = useQueryClient();

const id = computed(() => {
  const v = route.params.id;
  return typeof v === "string" ? v : "";
});

const ruleQuery = useQuery({
  queryKey: computed(() => queryKeys.rule(id.value)),
  enabled: computed(() => id.value.length > 0),
  queryFn: async () => {
    const { data, error } = await api.GET("/v1/rules/{id}", { params: { path: { id: id.value } } });
    if (error) throw error;
    return data;
  },
});

const firingsQuery = useQuery({
  queryKey: computed(() => queryKeys.ruleFirings(id.value)),
  enabled: computed(() => id.value.length > 0),
  refetchInterval: 5_000,
  queryFn: async () => {
    const { data, error } = await api.GET("/v1/rules/{id}/firings", {
      params: { path: { id: id.value }, query: { limit: 50 } },
    });
    if (error) throw error;
    return data;
  },
});

const items = computed(() => firingsQuery.data.value?.items ?? []);

const STATUS_META: Record<RuleFiringStatus, { icon: any; tone: string; label: string }> = {
  pending:    { icon: Clock,        tone: "text-muted-foreground", label: "Pending" },
  running:    { icon: Play,         tone: "text-blue-500",         label: "Running" },
  succeeded:  { icon: CheckCircle2, tone: "text-emerald-500",      label: "Succeeded" },
  failed:     { icon: AlertCircle,  tone: "text-amber-500",        label: "Failed" },
  abandoned:  { icon: XCircle,      tone: "text-red-500",          label: "Abandoned" },
  skipped:    { icon: CircleSlash,  tone: "text-muted-foreground", label: "Skipped" },
};

const redeliveringId = ref<string | null>(null);
const redeliverMutation = useMutation({
  mutationFn: async (firingId: string) => {
    redeliveringId.value = firingId;
    const { error } = await api.POST("/v1/rules/firings/{id}/redeliver", {
      params: { path: { id: firingId } },
    });
    if (error) throw error;
  },
  onSuccess: () => {
    qc.invalidateQueries({ queryKey: queryKeys.ruleFirings(id.value) });
    toast.success("Redelivery queued");
  },
  onSettled: () => { redeliveringId.value = null; },
});

const detailOpen = ref(false);
const detail = ref<RuleFiring | null>(null);

function openDetail(f: RuleFiring) {
  detail.value = f;
  detailOpen.value = true;
}

function relative(iso: string | null): string {
  if (!iso) return "";
  try { return formatDistanceToNow(new Date(iso), { addSuffix: true }); }
  catch { return ""; }
}
</script>

<template>
  <div class="space-y-4">
    <Button
      variant="ghost"
      size="sm"
      class="-ml-2 text-muted-foreground"
      @click="router.push('/automations/rules')"
    >
      <ArrowLeft class="h-3.5 w-3.5 mr-1" /> Rules
    </Button>

    <header v-if="ruleQuery.data.value">
      <h2 class="text-xl font-semibold tracking-tight">Firings</h2>
      <p class="text-sm text-muted-foreground">
        {{ ruleQuery.data.value.name }}
      </p>
    </header>

    <Card>
      <CardContent class="p-0">
        <div v-if="firingsQuery.isLoading.value" class="p-4 space-y-2">
          <Skeleton v-for="n in 4" :key="n" class="h-12 w-full" />
        </div>
        <ul v-else-if="items.length > 0" class="divide-y">
          <li
            v-for="f in items"
            :key="f.id"
            class="flex items-start gap-3 p-3 hover:bg-accent/30 cursor-pointer"
            @click="openDetail(f)"
          >
            <component
              :is="STATUS_META[f.status].icon"
              :class="[
                'h-4 w-4 mt-0.5 shrink-0',
                STATUS_META[f.status].tone,
                f.status === 'running' && 'animate-pulse',
              ]"
            />
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-2 flex-wrap">
                <Badge variant="secondary" class="text-[10px]">{{ STATUS_META[f.status].label }}</Badge>
                <span class="text-xs text-muted-foreground">
                  attempt {{ f.attempts }}
                </span>
                <span class="text-xs text-muted-foreground">
                  · created {{ relative(f.created_at) }}
                </span>
                <span
                  v-if="f.next_attempt_at && (f.status === 'pending' || f.status === 'failed')"
                  class="text-xs text-muted-foreground"
                >
                  · next try {{ relative(f.next_attempt_at) }}
                </span>
              </div>
              <p
                v-if="f.last_error"
                class="text-xs text-destructive mt-1 font-mono line-clamp-2"
              >{{ f.last_error }}</p>
            </div>
            <Button
              v-if="f.status === 'failed' || f.status === 'abandoned' || f.status === 'skipped'"
              variant="ghost"
              size="sm"
              :disabled="redeliveringId === f.id"
              @click.stop="redeliverMutation.mutate(f.id)"
            >
              <Loader2 v-if="redeliveringId === f.id" class="h-3.5 w-3.5 mr-1 animate-spin" />
              <RefreshCw v-else class="h-3.5 w-3.5 mr-1" />
              Redeliver
            </Button>
          </li>
        </ul>
        <EmptyState
          v-else
          :icon="Inbox"
          title="No firings yet"
          description="The rule's firings will appear here once it matches an event or schedule tick."
          size="sm"
        />
      </CardContent>
    </Card>

    <!-- Detail drawer: result_summary breakdown -->
    <Sheet v-model:open="detailOpen">
      <SheetContent side="right" class="w-full sm:max-w-md overflow-y-auto">
        <SheetHeader>
          <SheetTitle class="flex items-center gap-2">
            <component
              v-if="detail"
              :is="STATUS_META[detail.status].icon"
              :class="['h-4 w-4', STATUS_META[detail.status].tone]"
            />
            Firing {{ detail ? STATUS_META[detail.status].label.toLowerCase() : "" }}
          </SheetTitle>
          <SheetDescription v-if="detail">
            {{ relative(detail.created_at) }} · {{ detail.attempts }} attempt(s)
          </SheetDescription>
        </SheetHeader>
        <div v-if="detail" class="space-y-4 mt-4">
          <div v-if="detail.last_error" class="space-y-1">
            <div class="text-xs text-muted-foreground uppercase tracking-wide">Error</div>
            <pre class="text-xs font-mono p-2 rounded bg-destructive/10 text-destructive whitespace-pre-wrap break-all">{{ detail.last_error }}</pre>
          </div>

          <div v-if="detail.result_summary" class="space-y-2">
            <div class="text-xs text-muted-foreground uppercase tracking-wide">Conditions</div>
            <div class="text-sm">
              <Badge
                :variant="detail.result_summary.conditions_matched === false ? 'secondary' : 'default'"
                class="text-[10px]"
              >
                {{ detail.result_summary.conditions_matched === false ? "did not match" : "matched" }}
              </Badge>
              <span
                v-if="detail.result_summary.skip_reason"
                class="text-xs text-muted-foreground ml-2"
              >{{ detail.result_summary.skip_reason }}</span>
            </div>

            <div
              v-if="(detail.result_summary.actions?.length ?? 0) > 0"
              class="text-xs text-muted-foreground uppercase tracking-wide pt-2"
            >Actions</div>
            <ul v-if="detail.result_summary.actions" class="space-y-1">
              <li
                v-for="(a, i) in detail.result_summary.actions"
                :key="i"
                class="flex items-start gap-2 text-sm"
              >
                <CheckCircle2
                  v-if="a.status === 'ok'"
                  class="h-4 w-4 text-emerald-500 mt-0.5 shrink-0"
                />
                <XCircle v-else class="h-4 w-4 text-destructive mt-0.5 shrink-0" />
                <div class="min-w-0 flex-1">
                  <div class="font-mono text-xs">{{ a.type }}</div>
                  <div
                    v-if="a.error"
                    class="text-xs text-destructive font-mono break-all"
                  >{{ a.error }}</div>
                </div>
              </li>
            </ul>
          </div>

          <div class="space-y-1">
            <div class="text-xs text-muted-foreground uppercase tracking-wide">References</div>
            <dl class="text-xs space-y-0.5">
              <div class="flex gap-2">
                <dt class="text-muted-foreground w-20 shrink-0">firing</dt>
                <dd class="font-mono break-all">{{ detail.id }}</dd>
              </div>
              <div v-if="detail.event_id" class="flex gap-2">
                <dt class="text-muted-foreground w-20 shrink-0">event</dt>
                <dd class="font-mono break-all">{{ detail.event_id }}</dd>
              </div>
              <div v-if="detail.ticket_id" class="flex gap-2">
                <dt class="text-muted-foreground w-20 shrink-0">ticket</dt>
                <dd class="font-mono break-all">{{ detail.ticket_id }}</dd>
              </div>
            </dl>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  </div>
</template>
