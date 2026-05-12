<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { RouterLink } from "vue-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/vue-query";
import {
  Plus, Loader2, Trash2, Pencil, Webhook, Copy, AlertTriangle, ChevronRight,
  Power, PowerOff,
} from "lucide-vue-next";
import { toast } from "vue-sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import EmptyState from "@/components/EmptyState.vue";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { api } from "@/lib/api";
import { queryKeys } from "@/lib/queryKeys";
import type { EventType, WebhookSubscription } from "@switchyard/shared";

const qc = useQueryClient();

const subsQuery = useQuery({
  queryKey: queryKeys.webhooks(),
  queryFn: async () => {
    const { data, error } = await api.GET("/v1/webhooks", { params: { query: { limit: 200 } } });
    if (error) throw error;
    return data;
  },
});
const items = computed(() => subsQuery.data.value?.items ?? []);

const targetsQuery = useQuery({
  queryKey: queryKeys.targets(),
  queryFn: async () => {
    const { data, error } = await api.GET("/v1/targets", { params: { query: { limit: 200 } } });
    if (error) throw error;
    return data;
  },
});
const targets = computed(() => targetsQuery.data.value?.items ?? []);
function targetById(id: string | null | undefined) {
  if (!id) return null;
  return targets.value.find((t) => t.id === id) ?? null;
}

// ─── create / edit dialog ───────────────────────────────────────────────────
const dialogOpen = ref(false);
const editing = ref<WebhookSubscription | null>(null);
const draftUrl = ref("");
const draftActive = ref(true);
const draftEvents = ref<Set<string>>(new Set(["*"]));
// "" = literal URL form; a uuid = attach to that target.
const draftTargetId = ref<string>("");
const fresh = ref<{ secret: string; url: string } | null>(null);

const ALL_EVENTS: EventType[] = [
  "ticket.created", "ticket.updated", "ticket.status_changed", "ticket.assigned",
  "ticket.closed", "ticket.released", "ticket.deleted",
  "comment.created", "comment.updated", "comment.deleted",
  "attachment.added", "attachment.removed",
  "project.created", "project.updated", "project.deleted",
];

watch(dialogOpen, (v) => {
  if (!v) {
    editing.value = null;
    fresh.value = null;
  }
});

function openCreate() {
  editing.value = null;
  draftUrl.value = "";
  draftActive.value = true;
  draftEvents.value = new Set(["*"]);
  draftTargetId.value = "";
  fresh.value = null;
  dialogOpen.value = true;
}

function openEdit(s: WebhookSubscription) {
  editing.value = s;
  draftUrl.value = s.url;
  draftActive.value = s.active;
  draftEvents.value = new Set(s.event_types as string[]);
  draftTargetId.value = s.target_id ?? "";
  fresh.value = null;
  dialogOpen.value = true;
}

function toggleEvent(e: string) {
  const next = new Set(draftEvents.value);
  if (next.has(e)) next.delete(e);
  else next.add(e);
  // Picking a specific event clears the wildcard, and vice versa.
  if (e !== "*" && next.has("*")) next.delete("*");
  if (e === "*" && next.has("*")) {
    for (const v of [...next]) if (v !== "*") next.delete(v);
  }
  draftEvents.value = next;
}

const saveMutation = useMutation({
  mutationFn: async () => {
    const target_id = draftTargetId.value === "" ? null : draftTargetId.value;
    // When attached to a target, the literal URL becomes a fallback only.
    // Send the target's URL as the literal so the row stays useful if the
    // target is later deleted (FK is ON DELETE SET NULL).
    const t = target_id ? targetById(target_id) : null;
    const url = t ? t.url : draftUrl.value.trim();

    if (editing.value) {
      const { data, error } = await api.PATCH("/v1/webhooks/{id}", {
        params: { path: { id: editing.value.id } },
        body: {
          url,
          event_types: Array.from(draftEvents.value) as never,
          active: draftActive.value,
          target_id,
        },
      });
      if (error) throw error;
      return { kind: "updated" as const, data };
    }
    const { data, error } = await api.POST("/v1/webhooks", {
      body: {
        url,
        event_types: Array.from(draftEvents.value) as never,
        active: draftActive.value,
        ...(target_id ? { target_id } : {}),
      },
    });
    if (error) throw error;
    return { kind: "created" as const, data };
  },
  onSuccess: (result) => {
    qc.invalidateQueries({ queryKey: queryKeys.webhooks() });
    if (result.kind === "created" && result.data?.secret) {
      fresh.value = { secret: result.data.secret, url: result.data.url };
      // Don't close — show the secret screen.
    } else {
      toast.success("Webhook updated");
      dialogOpen.value = false;
    }
  },
});

const deletingId = ref<string | null>(null);
const deleteMutation = useMutation({
  mutationFn: async (id: string) => {
    deletingId.value = id;
    const { error } = await api.DELETE("/v1/webhooks/{id}", { params: { path: { id } } });
    if (error) throw error;
  },
  onSuccess: () => {
    qc.invalidateQueries({ queryKey: queryKeys.webhooks() });
    toast.success("Webhook deleted");
  },
  onSettled: () => { deletingId.value = null; },
});

const togglingId = ref<string | null>(null);
const toggleMutation = useMutation({
  mutationFn: async (sub: WebhookSubscription) => {
    togglingId.value = sub.id;
    const { error } = await api.PATCH("/v1/webhooks/{id}", {
      params: { path: { id: sub.id } },
      body: { active: !sub.active },
    });
    if (error) throw error;
  },
  onSuccess: () => {
    qc.invalidateQueries({ queryKey: queryKeys.webhooks() });
  },
  onSettled: () => { togglingId.value = null; },
});

async function copySecret() {
  if (!fresh.value) return;
  try {
    await navigator.clipboard.writeText(fresh.value.secret);
    toast.success("Secret copied");
  } catch {
    toast.error("Couldn't copy — select and copy manually");
  }
}

const canSave = computed(() => {
  if (draftEvents.value.size === 0) return false;
  if (draftTargetId.value) return true;          // target provides the URL
  return draftUrl.value.trim().length > 0;
});
</script>

<template>
  <div class="space-y-4">
    <header class="flex items-end justify-between gap-3">
      <div>
        <h2 class="text-xl font-semibold tracking-tight">Webhooks</h2>
        <p class="text-sm text-muted-foreground">
          POST events to external URLs as tickets change. Each delivery is
          HMAC-signed with the subscription's secret.
        </p>
      </div>
      <Button size="sm" @click="openCreate">
        <Plus class="h-3.5 w-3.5 mr-1.5" /> New webhook
      </Button>
    </header>

    <Card>
      <CardContent class="p-0">
        <div v-if="subsQuery.isLoading.value" class="p-4 space-y-2">
          <Skeleton v-for="n in 3" :key="n" class="h-14 w-full" />
        </div>
        <ul v-else-if="items.length > 0" class="divide-y">
          <li v-for="s in items" :key="s.id" class="flex items-start gap-3 p-3">
            <Webhook class="h-4 w-4 text-muted-foreground shrink-0 mt-1" />
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-2">
                <Badge
                  v-if="s.target_id"
                  variant="outline"
                  class="text-[10px] font-mono"
                >via {{ targetById(s.target_id)?.name ?? "target" }}</Badge>
                <span class="font-mono text-sm truncate">{{ s.url }}</span>
                <Badge v-if="!s.active" variant="secondary" class="text-[10px]">paused</Badge>
              </div>
              <div class="flex flex-wrap gap-1 mt-1">
                <span
                  v-for="e in s.event_types"
                  :key="e"
                  class="rounded border px-1 py-0 font-mono text-[10px] text-muted-foreground"
                >{{ e }}</span>
              </div>
            </div>
            <RouterLink
              :to="`/automations/webhooks/${s.id}/deliveries`"
              class="text-xs text-muted-foreground hover:text-foreground inline-flex items-center self-center"
            >
              Deliveries <ChevronRight class="h-3 w-3 ml-0.5" />
            </RouterLink>
            <Button
              variant="ghost"
              size="sm"
              :disabled="togglingId === s.id"
              :title="s.active ? 'Pause' : 'Resume'"
              @click="toggleMutation.mutate(s)"
            >
              <Loader2 v-if="togglingId === s.id" class="h-3.5 w-3.5 animate-spin" />
              <component :is="s.active ? Power : PowerOff" v-else class="h-3.5 w-3.5" />
            </Button>
            <Button variant="ghost" size="sm" @click="openEdit(s)">
              <Pencil class="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              class="text-muted-foreground hover:text-destructive"
              :disabled="deletingId === s.id"
              @click="deleteMutation.mutate(s.id)"
            >
              <Loader2 v-if="deletingId === s.id" class="h-3.5 w-3.5 animate-spin" />
              <Trash2 v-else class="h-3.5 w-3.5" />
            </Button>
          </li>
        </ul>
        <EmptyState
          v-else
          :icon="Webhook"
          title="No webhooks yet"
          description="Subscribe an external endpoint to ticket / comment / status events."
        >
          <template #action>
            <Button size="sm" @click="openCreate">
              <Plus class="h-3.5 w-3.5 mr-1.5" /> New webhook
            </Button>
          </template>
        </EmptyState>
      </CardContent>
    </Card>

    <Dialog v-model:open="dialogOpen">
      <DialogContent class="sm:max-w-lg">
        <template v-if="!fresh">
          <DialogHeader>
            <DialogTitle>{{ editing ? "Edit webhook" : "New webhook" }}</DialogTitle>
            <DialogDescription>
              The destination URL receives JSON POSTs with HMAC-SHA256 signed
              bodies. Pick "*" to subscribe to every event.
            </DialogDescription>
          </DialogHeader>
          <div class="space-y-3">
            <div class="space-y-1.5">
              <Label for="hook-target">Target</Label>
              <select
                id="hook-target"
                v-model="draftTargetId"
                class="w-full rounded-md border bg-background px-2 py-1.5 text-sm"
              >
                <option value="">Use literal URL below</option>
                <option v-for="t in targets" :key="t.id" :value="t.id">
                  {{ t.name }} — {{ t.url }}
                </option>
              </select>
              <p v-if="draftTargetId" class="text-xs text-muted-foreground">
                URL + headers resolve from the target at delivery time. Updates to
                the target propagate without re-creating this subscription.
              </p>
            </div>
            <div class="space-y-1.5" v-if="!draftTargetId">
              <Label for="hook-url">URL</Label>
              <Input
                id="hook-url"
                v-model="draftUrl"
                placeholder="https://n8n.example/webhook/abc"
                autofocus
              />
            </div>
            <div class="space-y-1.5">
              <Label>Events</Label>
              <div class="rounded-md border max-h-56 overflow-auto divide-y">
                <label
                  class="flex items-center gap-2 px-3 py-2 text-sm hover:bg-accent/40 cursor-pointer"
                  @click.prevent="toggleEvent('*')"
                >
                  <Checkbox
                    :model-value="draftEvents.has('*')"
                    @click.stop="toggleEvent('*')"
                  />
                  <span class="font-mono text-xs">*</span>
                  <span class="text-xs text-muted-foreground">All events</span>
                </label>
                <label
                  v-for="e in ALL_EVENTS"
                  :key="e"
                  class="flex items-center gap-2 px-3 py-2 text-sm hover:bg-accent/40 cursor-pointer"
                  @click.prevent="toggleEvent(e)"
                >
                  <Checkbox
                    :model-value="draftEvents.has(e)"
                    :disabled="draftEvents.has('*')"
                    @click.stop="toggleEvent(e)"
                  />
                  <span class="font-mono text-xs">{{ e }}</span>
                </label>
              </div>
            </div>
            <label class="flex items-center gap-2 text-sm cursor-pointer">
              <Checkbox v-model="draftActive" />
              Active (paused subscriptions don't receive deliveries)
            </label>
          </div>
          <DialogFooter>
            <Button variant="ghost" @click="dialogOpen = false">Cancel</Button>
            <Button :disabled="!canSave || saveMutation.isPending.value" @click="saveMutation.mutate()">
              <Loader2 v-if="saveMutation.isPending.value" class="h-3.5 w-3.5 mr-1.5 animate-spin" />
              {{ editing ? "Save" : "Create webhook" }}
            </Button>
          </DialogFooter>
        </template>

        <template v-else>
          <DialogHeader>
            <DialogTitle class="flex items-center gap-2">
              <AlertTriangle class="h-4 w-4 text-amber-500" />
              Copy the signing secret now
            </DialogTitle>
            <DialogDescription>
              "{{ fresh.url }}" is live. The HMAC secret is shown ONCE — after
              you close this dialog, only the hashed value remains.
            </DialogDescription>
          </DialogHeader>
          <div class="rounded-md border bg-muted/40 p-3 font-mono text-xs break-all">
            {{ fresh.secret }}
          </div>
          <DialogFooter>
            <Button variant="ghost" @click="copySecret">
              <Copy class="h-3.5 w-3.5 mr-1.5" /> Copy
            </Button>
            <Button @click="dialogOpen = false">Done</Button>
          </DialogFooter>
        </template>
      </DialogContent>
    </Dialog>
  </div>
</template>
