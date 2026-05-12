<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useMutation, useQuery, useQueryClient } from "@tanstack/vue-query";
import {
  Plus, Loader2, Trash2, Pencil, Copy, AlertTriangle, Send,
} from "lucide-vue-next";
import { toast } from "vue-sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import EmptyState from "@/components/EmptyState.vue";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { api } from "@/lib/api";
import { queryKeys } from "@/lib/queryKeys";
import type { Target } from "@switchyard/shared";

const qc = useQueryClient();

const targetsQuery = useQuery({
  queryKey: queryKeys.targets(),
  queryFn: async () => {
    const { data, error } = await api.GET("/v1/targets", { params: { query: { limit: 200 } } });
    if (error) throw error;
    return data;
  },
});
const items = computed(() => targetsQuery.data.value?.items ?? []);

// ─── create / edit dialog ───────────────────────────────────────────────────
const dialogOpen = ref(false);
const editing = ref<Target | null>(null);
const draftName = ref("");
const draftUrl = ref("");
const draftDescription = ref("");
// Headers: one "Key: value" per line. Parsed on save.
const draftHeadersText = ref("");
const fresh = ref<{ name: string; secret: string | null } | null>(null);

watch(dialogOpen, (v) => {
  if (!v) {
    editing.value = null;
    fresh.value = null;
  }
});

function openCreate() {
  editing.value = null;
  draftName.value = "";
  draftUrl.value = "";
  draftDescription.value = "";
  draftHeadersText.value = "";
  fresh.value = null;
  dialogOpen.value = true;
}

function openEdit(t: Target) {
  editing.value = t;
  draftName.value = t.name;
  draftUrl.value = t.url;
  draftDescription.value = t.description ?? "";
  draftHeadersText.value = headersToText(t.headers);
  fresh.value = null;
  dialogOpen.value = true;
}

function headersToText(h: Record<string, string> | null | undefined): string {
  if (!h) return "";
  return Object.entries(h).map(([k, v]) => `${k}: ${v}`).join("\n");
}

function parseHeaders(text: string): Record<string, string> | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  const out: Record<string, string> = {};
  for (const raw of trimmed.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf(":");
    if (idx === -1) throw new Error(`malformed header: "${line}" — expected "Key: value"`);
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (!key) throw new Error(`malformed header: empty key in "${line}"`);
    out[key] = value;
  }
  return out;
}

const saveMutation = useMutation({
  mutationFn: async () => {
    let headers: Record<string, string> | undefined;
    try {
      headers = parseHeaders(draftHeadersText.value);
    } catch (err) {
      throw new Error((err as Error).message);
    }
    if (editing.value) {
      const { data, error } = await api.PATCH("/v1/targets/{id}", {
        params: { path: { id: editing.value.id } },
        body: {
          name: draftName.value.trim(),
          url: draftUrl.value.trim(),
          description: draftDescription.value.trim() || null,
          headers: headers ?? null,
        },
      });
      if (error) throw error;
      return { kind: "updated" as const, data };
    }
    const { data, error } = await api.POST("/v1/targets", {
      body: {
        name: draftName.value.trim(),
        url: draftUrl.value.trim(),
        description: draftDescription.value.trim() || undefined,
        headers,
      },
    });
    if (error) throw error;
    return { kind: "created" as const, data };
  },
  onSuccess: (result) => {
    qc.invalidateQueries({ queryKey: queryKeys.targets() });
    if (result.kind === "created" && result.data) {
      // Reveal secret screen (or close if signing was disabled).
      fresh.value = { name: result.data.name, secret: result.data.hmac_secret };
    } else {
      toast.success("Target updated");
      dialogOpen.value = false;
    }
  },
  onError: (err: Error) => {
    toast.error(err.message ?? "Save failed");
  },
});

// ─── delete (with referencer surfacing) ─────────────────────────────────────
const deletingId = ref<string | null>(null);
const deleteConflict = ref<{ name: string; subscription_ids: string[]; rule_ids: string[] } | null>(null);

const deleteMutation = useMutation({
  mutationFn: async (t: Target) => {
    deletingId.value = t.id;
    const { error } = await api.DELETE("/v1/targets/{id}", { params: { path: { id: t.id } } });
    if (error) {
      // openapi-fetch error shape is { error: { code, message, details? } }.
      const e = error as { error?: { code?: string; message?: string; details?: { subscription_ids?: string[]; rule_ids?: string[] } } };
      if (e?.error?.code === "conflict") {
        deleteConflict.value = {
          name: t.name,
          subscription_ids: e.error.details?.subscription_ids ?? [],
          rule_ids: e.error.details?.rule_ids ?? [],
        };
        return;
      }
      throw error;
    }
    toast.success(`Target "${t.name}" deleted`);
  },
  onSuccess: () => {
    qc.invalidateQueries({ queryKey: queryKeys.targets() });
  },
  onSettled: () => { deletingId.value = null; },
});

async function copySecret() {
  if (!fresh.value?.secret) return;
  try {
    await navigator.clipboard.writeText(fresh.value.secret);
    toast.success("Secret copied");
  } catch {
    toast.error("Couldn't copy — select and copy manually");
  }
}

const canSave = computed(() =>
  draftName.value.trim().length > 0 && draftUrl.value.trim().length > 0
);
</script>

<template>
  <div class="space-y-4">
    <header class="flex items-end justify-between gap-3">
      <div>
        <h2 class="text-xl font-semibold tracking-tight">Targets</h2>
        <p class="text-sm text-muted-foreground">
          Named webhook endpoints. Reference by name from rules and subscriptions
          so swapping a host is one edit.
        </p>
      </div>
      <Button size="sm" @click="openCreate">
        <Plus class="h-3.5 w-3.5 mr-1.5" /> New target
      </Button>
    </header>

    <Card>
      <CardContent class="p-0">
        <div v-if="targetsQuery.isLoading.value" class="p-4 space-y-2">
          <Skeleton v-for="n in 3" :key="n" class="h-14 w-full" />
        </div>
        <ul v-else-if="items.length > 0" class="divide-y">
          <li v-for="t in items" :key="t.id" class="flex items-start gap-3 p-3">
            <Send class="h-4 w-4 text-muted-foreground shrink-0 mt-1" />
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-2">
                <span class="font-medium text-sm">{{ t.name }}</span>
                <span class="font-mono text-xs text-muted-foreground truncate">{{ t.url }}</span>
              </div>
              <div v-if="t.description" class="text-xs text-muted-foreground mt-0.5 truncate">
                {{ t.description }}
              </div>
            </div>
            <Button variant="ghost" size="sm" @click="openEdit(t)">
              <Pencil class="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              class="text-muted-foreground hover:text-destructive"
              :disabled="deletingId === t.id"
              @click="deleteMutation.mutate(t)"
            >
              <Loader2 v-if="deletingId === t.id" class="h-3.5 w-3.5 animate-spin" />
              <Trash2 v-else class="h-3.5 w-3.5" />
            </Button>
          </li>
        </ul>
        <EmptyState
          v-else
          :icon="Send"
          title="No targets yet"
          description="A target wraps a destination URL with optional headers and HMAC secret. Rules and subscriptions reference it by name."
        >
          <template #action>
            <Button size="sm" @click="openCreate">
              <Plus class="h-3.5 w-3.5 mr-1.5" /> New target
            </Button>
          </template>
        </EmptyState>
      </CardContent>
    </Card>

    <Dialog v-model:open="dialogOpen">
      <DialogContent class="sm:max-w-lg">
        <template v-if="!fresh">
          <DialogHeader>
            <DialogTitle>{{ editing ? "Edit target" : "New target" }}</DialogTitle>
            <DialogDescription>
              Name is used to reference this target from rules. URL is the
              destination; optional headers are merged into every outbound
              request.
            </DialogDescription>
          </DialogHeader>
          <div class="space-y-3">
            <div class="space-y-1.5">
              <Label for="tgt-name">Name</Label>
              <Input
                id="tgt-name"
                v-model="draftName"
                placeholder="n8n"
                autofocus
                :disabled="!!editing"
              />
              <p v-if="editing" class="text-xs text-muted-foreground">
                Rename in API; lowercase, alphanumeric + dash/underscore.
              </p>
            </div>
            <div class="space-y-1.5">
              <Label for="tgt-url">URL</Label>
              <Input
                id="tgt-url"
                v-model="draftUrl"
                placeholder="http://n8n:5678"
              />
            </div>
            <div class="space-y-1.5">
              <Label for="tgt-description">Description (optional)</Label>
              <Input
                id="tgt-description"
                v-model="draftDescription"
                placeholder="n8n on the homelab"
              />
            </div>
            <div class="space-y-1.5">
              <Label for="tgt-headers">Headers (optional)</Label>
              <textarea
                id="tgt-headers"
                v-model="draftHeadersText"
                placeholder="Authorization: Bearer xyz&#10;X-Source: switchyard"
                rows="4"
                class="w-full rounded-md border bg-background px-3 py-2 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-ring resize-y"
              />
              <p class="text-xs text-muted-foreground">
                One <code>Key: value</code> per line. Per-action headers
                override these on collision.
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" @click="dialogOpen = false">Cancel</Button>
            <Button
              :disabled="!canSave || saveMutation.isPending.value"
              @click="saveMutation.mutate()"
            >
              <Loader2 v-if="saveMutation.isPending.value" class="h-3.5 w-3.5 mr-1.5 animate-spin" />
              {{ editing ? "Save" : "Create target" }}
            </Button>
          </DialogFooter>
        </template>

        <template v-else>
          <DialogHeader>
            <DialogTitle class="flex items-center gap-2">
              <AlertTriangle class="h-4 w-4 text-amber-500" />
              {{ fresh.secret ? "Copy the signing secret now" : "Target created" }}
            </DialogTitle>
            <DialogDescription>
              <template v-if="fresh.secret">
                "{{ fresh.name }}" is live. The HMAC secret is shown ONCE — after
                you close this dialog, only the hashed value remains.
              </template>
              <template v-else>
                "{{ fresh.name }}" is live with HMAC disabled. Rules referencing it
                will fall back to their own webhook_secret for signing.
              </template>
            </DialogDescription>
          </DialogHeader>
          <div
            v-if="fresh.secret"
            class="rounded-md border bg-muted/40 p-3 font-mono text-xs break-all"
          >
            {{ fresh.secret }}
          </div>
          <DialogFooter>
            <Button v-if="fresh.secret" variant="ghost" @click="copySecret">
              <Copy class="h-3.5 w-3.5 mr-1.5" /> Copy
            </Button>
            <Button @click="dialogOpen = false">Done</Button>
          </DialogFooter>
        </template>
      </DialogContent>
    </Dialog>

    <!-- Delete conflict prompt: target still referenced. -->
    <Dialog
      :open="deleteConflict !== null"
      @update:open="(v) => { if (!v) deleteConflict = null; }"
    >
      <DialogContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle class="flex items-center gap-2">
            <AlertTriangle class="h-4 w-4 text-amber-500" />
            Target still in use
          </DialogTitle>
          <DialogDescription>
            "{{ deleteConflict?.name }}" can't be deleted yet. Detach it from the
            references below first.
          </DialogDescription>
        </DialogHeader>
        <div class="space-y-2 text-sm">
          <div v-if="(deleteConflict?.subscription_ids.length ?? 0) > 0">
            <span class="text-muted-foreground">Webhook subscriptions:</span>
            <ul class="font-mono text-xs mt-1 space-y-0.5">
              <li v-for="id in deleteConflict?.subscription_ids" :key="id">{{ id }}</li>
            </ul>
          </div>
          <div v-if="(deleteConflict?.rule_ids.length ?? 0) > 0">
            <span class="text-muted-foreground">Rules:</span>
            <ul class="font-mono text-xs mt-1 space-y-0.5">
              <li v-for="id in deleteConflict?.rule_ids" :key="id">{{ id }}</li>
            </ul>
          </div>
        </div>
        <DialogFooter>
          <Button @click="deleteConflict = null">OK</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>
