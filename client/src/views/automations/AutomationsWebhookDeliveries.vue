<script setup lang="ts">
import { computed, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/vue-query";
import {
  ArrowLeft, Loader2, RefreshCw, CheckCircle2, XCircle, Clock, AlertCircle, Inbox,
} from "lucide-vue-next";
import { formatDistanceToNow } from "date-fns";
import { toast } from "vue-sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import EmptyState from "@/components/EmptyState.vue";
import { api } from "@/lib/api";
import { queryKeys } from "@/lib/queryKeys";
import type { WebhookDeliveryStatus } from "@switchyard/shared";

const route = useRoute();
const router = useRouter();
const qc = useQueryClient();

const id = computed(() => {
  const v = route.params.id;
  return typeof v === "string" ? v : "";
});

const subQuery = useQuery({
  queryKey: computed(() => queryKeys.webhook(id.value)),
  enabled: computed(() => id.value.length > 0),
  queryFn: async () => {
    const { data, error } = await api.GET("/v1/webhooks/{id}", { params: { path: { id: id.value } } });
    if (error) throw error;
    return data;
  },
});

const deliveriesQuery = useQuery({
  queryKey: computed(() => queryKeys.webhookDeliveries(id.value)),
  enabled: computed(() => id.value.length > 0),
  refetchInterval: 5_000, // light polling so the user sees the dispatcher update
  queryFn: async () => {
    const { data, error } = await api.GET("/v1/webhooks/{id}/deliveries", {
      params: { path: { id: id.value }, query: { limit: 50 } },
    });
    if (error) throw error;
    return data;
  },
});

const items = computed(() => deliveriesQuery.data.value?.items ?? []);

const STATUS_META: Record<WebhookDeliveryStatus, { icon: any; tone: string; label: string }> = {
  pending: { icon: Clock, tone: "text-muted-foreground", label: "Pending" },
  delivering: { icon: Loader2, tone: "text-blue-500", label: "Delivering" },
  succeeded: { icon: CheckCircle2, tone: "text-emerald-500", label: "Succeeded" },
  failed: { icon: AlertCircle, tone: "text-amber-500", label: "Retrying" },
  abandoned: { icon: XCircle, tone: "text-red-500", label: "Abandoned" },
};

const redeliveringId = ref<string | null>(null);
const redeliverMutation = useMutation({
  mutationFn: async (deliveryId: string) => {
    redeliveringId.value = deliveryId;
    const { error } = await api.POST("/v1/webhooks/deliveries/{id}/redeliver", {
      params: { path: { id: deliveryId } },
    });
    if (error) throw error;
  },
  onSuccess: () => {
    qc.invalidateQueries({ queryKey: queryKeys.webhookDeliveries(id.value) });
    toast.success("Redelivery queued");
  },
  onSettled: () => { redeliveringId.value = null; },
});

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
      @click="router.push('/automations/webhooks')"
    >
      <ArrowLeft class="h-3.5 w-3.5 mr-1" /> Webhooks
    </Button>

    <header v-if="subQuery.data.value">
      <h2 class="text-xl font-semibold tracking-tight">Deliveries</h2>
      <p class="text-sm text-muted-foreground font-mono break-all">
        {{ subQuery.data.value.url }}
      </p>
    </header>

    <Card>
      <CardContent class="p-0">
        <div v-if="deliveriesQuery.isLoading.value" class="p-4 space-y-2">
          <Skeleton v-for="n in 4" :key="n" class="h-12 w-full" />
        </div>
        <ul v-else-if="items.length > 0" class="divide-y">
          <li
            v-for="d in items"
            :key="d.id"
            class="flex items-start gap-3 p-3"
          >
            <component
              :is="STATUS_META[d.status].icon"
              :class="[
                'h-4 w-4 mt-0.5 shrink-0',
                STATUS_META[d.status].tone,
                d.status === 'delivering' && 'animate-spin',
              ]"
            />
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-2 flex-wrap">
                <Badge variant="secondary" class="text-[10px]">{{ STATUS_META[d.status].label }}</Badge>
                <span v-if="d.response_code !== null" class="text-xs text-muted-foreground">
                  HTTP {{ d.response_code }}
                </span>
                <span class="text-xs text-muted-foreground">
                  · attempt {{ d.attempts }}
                </span>
                <span class="text-xs text-muted-foreground">
                  · created {{ relative(d.created_at) }}
                </span>
                <span
                  v-if="d.next_attempt_at && (d.status === 'pending' || d.status === 'failed')"
                  class="text-xs text-muted-foreground"
                >
                  · next try {{ relative(d.next_attempt_at) }}
                </span>
              </div>
              <p
                v-if="d.last_error"
                class="text-xs text-destructive mt-1 font-mono"
              >{{ d.last_error }}</p>
              <p
                v-else-if="d.response_body_excerpt"
                class="text-xs text-muted-foreground/80 mt-1 font-mono line-clamp-2"
              >{{ d.response_body_excerpt }}</p>
            </div>
            <Button
              v-if="d.status === 'failed' || d.status === 'abandoned'"
              variant="ghost"
              size="sm"
              :disabled="redeliveringId === d.id"
              @click="redeliverMutation.mutate(d.id)"
            >
              <Loader2 v-if="redeliveringId === d.id" class="h-3.5 w-3.5 mr-1 animate-spin" />
              <RefreshCw v-else class="h-3.5 w-3.5 mr-1" />
              Redeliver
            </Button>
          </li>
        </ul>
        <EmptyState
          v-else
          :icon="Inbox"
          title="No deliveries yet"
          description="Outbound calls will appear here once the subscription fires."
          size="sm"
        />
      </CardContent>
    </Card>
  </div>
</template>
