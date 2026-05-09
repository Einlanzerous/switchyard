<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useMutation, useQuery, useQueryClient } from "@tanstack/vue-query";
import {
  Plus, Loader2, Trash2, Copy, KeyRound, AlertTriangle,
} from "lucide-vue-next";
import { formatDistanceToNow } from "date-fns";
import { toast } from "vue-sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { useAuthStore } from "@/stores/auth";
import { api } from "@/lib/api";
import { queryKeys } from "@/lib/queryKeys";
import type { ApiTokenScope } from "@switchyard/shared";

const auth = useAuthStore();
const qc = useQueryClient();

const tokensQuery = useQuery({
  queryKey: computed(() => queryKeys.userTokens(auth.me?.id ?? "__none__")),
  enabled: computed(() => !!auth.me),
  queryFn: async () => {
    if (!auth.me) throw new Error("not authenticated");
    const { data, error } = await api.GET("/v1/users/{id}/tokens", {
      params: { path: { id: auth.me.id } },
    });
    if (error) throw error;
    return data;
  },
});

const allTokens = computed(() => tokensQuery.data.value?.items ?? []);

// Hide revoked tokens by default — they accumulate over time as agents
// rotate their keys and end up dominating the list. Keep them in the cache
// so audits can still surface them; just collapse from view.
const showRevoked = ref(false);
const items = computed(() =>
  showRevoked.value ? allTokens.value : allTokens.value.filter((t) => !t.revoked_at)
);
const revokedCount = computed(() => allTokens.value.filter((t) => t.revoked_at).length);

// ─── create dialog ──────────────────────────────────────────────────────────
const showCreate = ref(false);
const newName = ref("");
const SCOPE_OPTIONS: Array<{ value: ApiTokenScope; label: string; help: string }> = [
  { value: "admin", label: "admin", help: "Bypass all per-scope checks." },
  { value: "tickets:read", label: "tickets:read", help: "Read tickets, comments, attachments." },
  { value: "tickets:write", label: "tickets:write", help: "Create / update / transition tickets." },
  { value: "comments:write", label: "comments:write", help: "Add / edit / delete comments." },
  { value: "attachments:write", label: "attachments:write", help: "Upload / delete attachments." },
  { value: "projects:manage", label: "projects:manage", help: "Manage projects, statuses, labels." },
  { value: "users:manage", label: "users:manage", help: "Create / edit / delete users + tokens." },
  { value: "webhooks:manage", label: "webhooks:manage", help: "Create / delete webhook subscriptions." },
];
const scopes = ref<Set<ApiTokenScope>>(new Set(["tickets:read", "tickets:write", "comments:write"]));

watch(showCreate, (v) => {
  if (v) {
    newName.value = "";
    scopes.value = new Set(["tickets:read", "tickets:write", "comments:write"]);
    fresh.value = null;
  }
});

function toggleScope(s: ApiTokenScope) {
  const next = new Set(scopes.value);
  if (next.has(s)) next.delete(s);
  else next.add(s);
  scopes.value = next;
}

const fresh = ref<{ token: string; name: string } | null>(null);

const createMutation = useMutation({
  mutationFn: async () => {
    if (!auth.me) throw new Error("not authenticated");
    const { data, error } = await api.POST("/v1/users/{id}/tokens", {
      params: { path: { id: auth.me.id } },
      body: {
        name: newName.value.trim(),
        scopes: Array.from(scopes.value),
      },
    });
    if (error) throw error;
    return data;
  },
  onSuccess: (data) => {
    qc.invalidateQueries({ queryKey: queryKeys.userTokens(auth.me!.id) });
    if (data?.token) {
      fresh.value = { token: data.token, name: data.name };
    }
  },
});

async function copyFresh() {
  if (!fresh.value) return;
  try {
    await navigator.clipboard.writeText(fresh.value.token);
    toast.success("Token copied");
  } catch {
    toast.error("Couldn't copy — select and copy manually");
  }
}

// ─── revoke ─────────────────────────────────────────────────────────────────
const revokingId = ref<string | null>(null);

const revokeMutation = useMutation({
  mutationFn: async (tokenId: string) => {
    if (!auth.me) throw new Error("not authenticated");
    revokingId.value = tokenId;
    const { error } = await api.DELETE("/v1/users/{id}/tokens/{tokenId}", {
      params: { path: { id: auth.me.id, tokenId } },
    });
    if (error) throw error;
  },
  onSuccess: () => {
    qc.invalidateQueries({ queryKey: queryKeys.userTokens(auth.me!.id) });
    toast.success("Token revoked");
  },
  onSettled: () => { revokingId.value = null; },
});

function relative(iso: string | null): string {
  if (!iso) return "never";
  try { return formatDistanceToNow(new Date(iso), { addSuffix: true }); }
  catch { return ""; }
}
</script>

<template>
  <div class="space-y-4">
    <header class="flex items-end justify-between gap-3">
      <div>
        <h2 class="text-xl font-semibold tracking-tight">API tokens</h2>
        <p class="text-sm text-muted-foreground">
          Bearer tokens for accessing switchyard from your scripts and agents.
        </p>
      </div>
      <Button size="sm" @click="showCreate = true">
        <Plus class="h-3.5 w-3.5 mr-1.5" /> New token
      </Button>
    </header>

    <Card>
      <CardContent class="p-0">
        <div v-if="tokensQuery.isLoading.value" class="p-4 space-y-2">
          <Skeleton v-for="n in 3" :key="n" class="h-10 w-full" />
        </div>
        <ul v-else-if="items.length > 0" class="divide-y">
          <li
            v-for="t in items"
            :key="t.id"
            class="flex items-center gap-3 p-3"
          >
            <KeyRound class="h-4 w-4 text-muted-foreground shrink-0" />
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-2">
                <span class="font-medium truncate">{{ t.name }}</span>
                <Badge v-if="t.revoked_at" variant="destructive" class="text-[10px]">revoked</Badge>
              </div>
              <div class="flex items-center gap-1.5 mt-0.5 text-xs text-muted-foreground">
                <span
                  v-for="s in t.scopes"
                  :key="s"
                  class="rounded border px-1 py-0 font-mono text-[10px]"
                >{{ s }}</span>
              </div>
              <div class="text-[11px] text-muted-foreground mt-0.5">
                Created {{ relative(t.created_at) }} · Last used {{ relative(t.last_used_at) }}
              </div>
            </div>
            <Button
              v-if="!t.revoked_at"
              variant="ghost"
              size="sm"
              class="text-muted-foreground hover:text-destructive"
              :disabled="revokingId === t.id"
              @click="revokeMutation.mutate(t.id)"
            >
              <Loader2 v-if="revokingId === t.id" class="h-3.5 w-3.5 animate-spin" />
              <Trash2 v-else class="h-3.5 w-3.5" />
            </Button>
          </li>
        </ul>
        <p v-else class="p-6 text-sm text-muted-foreground text-center italic">
          No tokens yet.
        </p>
      </CardContent>
    </Card>

    <button
      v-if="revokedCount > 0"
      type="button"
      class="text-xs text-muted-foreground hover:text-foreground transition-colors"
      @click="showRevoked = !showRevoked"
    >
      {{ showRevoked
        ? `Hide ${revokedCount} revoked token${revokedCount === 1 ? "" : "s"}`
        : `Show ${revokedCount} revoked token${revokedCount === 1 ? "" : "s"}` }}
    </button>

    <Dialog v-model:open="showCreate">
      <DialogContent class="sm:max-w-md">
        <!-- Create form OR success banner depending on whether the mutation
             returned a token. The plaintext is only ever visible during this
             modal; closing forgets it forever. -->
        <template v-if="!fresh">
          <DialogHeader>
            <DialogTitle>New API token</DialogTitle>
            <DialogDescription>
              Pick a name and the scopes the token can use. The plaintext value
              is shown ONCE on the next screen.
            </DialogDescription>
          </DialogHeader>
          <div class="space-y-3">
            <div class="space-y-1.5">
              <Label for="t-name">Name</Label>
              <Input id="t-name" v-model="newName" placeholder="e.g. n8n-cogitation" autofocus />
            </div>
            <div class="space-y-1.5">
              <Label>Scopes</Label>
              <ul class="rounded-md border max-h-56 overflow-auto divide-y">
                <li
                  v-for="o in SCOPE_OPTIONS"
                  :key="o.value"
                  class="flex items-start gap-2 px-3 py-2 text-sm hover:bg-accent/40 cursor-pointer"
                  @click="toggleScope(o.value)"
                >
                  <Checkbox
                    :model-value="scopes.has(o.value)"
                    class="mt-0.5"
                    @click.stop="toggleScope(o.value)"
                  />
                  <div class="flex-1 min-w-0">
                    <div class="font-mono text-[12px]">{{ o.label }}</div>
                    <div class="text-[11px] text-muted-foreground">{{ o.help }}</div>
                  </div>
                </li>
              </ul>
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" @click="showCreate = false">Cancel</Button>
            <Button
              :disabled="
                newName.trim().length === 0
                || scopes.size === 0
                || createMutation.isPending.value
              "
              @click="createMutation.mutate()"
            >
              <Loader2
                v-if="createMutation.isPending.value"
                class="h-3.5 w-3.5 mr-1.5 animate-spin"
              />
              Create token
            </Button>
          </DialogFooter>
        </template>

        <template v-else>
          <DialogHeader>
            <DialogTitle class="flex items-center gap-2">
              <AlertTriangle class="h-4 w-4 text-amber-500" />
              Copy your token now
            </DialogTitle>
            <DialogDescription>
              "{{ fresh.name }}" was created. The plaintext is shown once —
              after closing this dialog, only the hashed value remains.
            </DialogDescription>
          </DialogHeader>
          <div class="rounded-md border bg-muted/40 p-3 font-mono text-xs break-all">
            {{ fresh.token }}
          </div>
          <DialogFooter>
            <Button variant="ghost" @click="copyFresh">
              <Copy class="h-3.5 w-3.5 mr-1.5" /> Copy
            </Button>
            <Button @click="showCreate = false">Done</Button>
          </DialogFooter>
        </template>
      </DialogContent>
    </Dialog>
  </div>
</template>
