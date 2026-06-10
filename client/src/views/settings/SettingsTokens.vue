<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useMutation, useQuery, useQueryClient } from "@tanstack/vue-query";
import {
  Plus, Loader2, Trash2, KeyRound, Eye,
} from "lucide-vue-next";
import { formatDistanceToNow } from "date-fns";
import { toast } from "vue-sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import TokenSecretReveal from "@/components/settings/TokenSecretReveal.vue";
import TokenScopePicker from "@/components/settings/TokenScopePicker.vue";
import { useAuthStore } from "@/stores/auth";
import { api } from "@/lib/api";
import { queryKeys } from "@/lib/queryKeys";
import { defaultTokenScopes } from "@/lib/tokenScopes";
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
// A dashboard token is read-only by construction — the server caps its scopes to
// the read-only bundle, so the dialog hides the scope picker entirely. `personal`
// is the regular flow with the full scope picker.
const createKind = ref<"personal" | "dashboard">("personal");
const isDashboard = computed(() => createKind.value === "dashboard");
const newName = ref("");

function openCreate(kind: "personal" | "dashboard") {
  createKind.value = kind;
  showCreate.value = true;
}
const scopes = ref<Set<ApiTokenScope>>(defaultTokenScopes());

watch(showCreate, (v) => {
  if (v) {
    newName.value = "";
    scopes.value = defaultTokenScopes();
    fresh.value = null;
  }
});

const fresh = ref<{ token: string; name: string } | null>(null);

const createMutation = useMutation({
  mutationFn: async () => {
    if (!auth.me) throw new Error("not authenticated");
    // Dashboard tokens send no scopes — the server fills the read-only bundle.
    const body = isDashboard.value
      ? { name: newName.value.trim(), kind: "dashboard" as const }
      : { name: newName.value.trim(), kind: "personal" as const, scopes: Array.from(scopes.value) };
    const { data, error } = await api.POST("/v1/users/{id}/tokens", {
      params: { path: { id: auth.me.id } },
      body,
    });
    if (error) throw error;
    return data;
  },
  onSuccess: (data) => {
    qc.invalidateQueries({ queryKey: queryKeys.userTokens(auth.me!.id) });
    // TokenSecretReveal renders the plaintext + QR from this once-shown value.
    if (data?.token) fresh.value = { token: data.token, name: data.name };
  },
});

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
      <div class="flex items-center gap-2">
        <Button size="sm" variant="outline" @click="openCreate('dashboard')">
          <Eye class="h-3.5 w-3.5 mr-1.5" /> Dashboard token
        </Button>
        <Button size="sm" @click="openCreate('personal')">
          <Plus class="h-3.5 w-3.5 mr-1.5" /> New token
        </Button>
      </div>
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
                <span v-if="t.kind === 'dashboard'" title="Read-only dashboard token">
                  <Badge variant="secondary" class="text-[10px] gap-1">
                    <Eye class="h-3 w-3" /> read-only
                  </Badge>
                </span>
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
            <DialogTitle>{{ isDashboard ? "New dashboard token" : "New API token" }}</DialogTitle>
            <DialogDescription v-if="isDashboard">
              A read-only token for embedding in dashboards or a public demo view.
              Scopes are fixed to read-only — it can never write. The plaintext
              value is shown ONCE on the next screen.
            </DialogDescription>
            <DialogDescription v-else>
              Pick a name and the scopes the token can use. The plaintext value
              is shown ONCE on the next screen.
            </DialogDescription>
          </DialogHeader>
          <div class="space-y-3">
            <div class="space-y-1.5">
              <Label for="t-name">Name</Label>
              <Input id="t-name" v-model="newName" placeholder="e.g. tablet 2026-05" autofocus />
            </div>
            <div
              v-if="isDashboard"
              class="flex items-start gap-2 rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground"
            >
              <Eye class="h-3.5 w-3.5 mt-0.5 shrink-0" />
              <span>
                Read-only (<code class="font-mono">tickets:read</code>). The token
                reads whatever projects its owner can see — for a scoped public
                demo, create it on a <strong>viewer</strong> user limited to the
                demo project.
              </span>
            </div>
            <div v-else class="space-y-1.5">
              <Label>Scopes</Label>
              <TokenScopePicker v-model="scopes" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" @click="showCreate = false">Cancel</Button>
            <Button
              :disabled="
                newName.trim().length === 0
                || (!isDashboard && scopes.size === 0)
                || createMutation.isPending.value
              "
              @click="createMutation.mutate()"
            >
              <Loader2
                v-if="createMutation.isPending.value"
                class="h-3.5 w-3.5 mr-1.5 animate-spin"
              />
              {{ isDashboard ? "Create dashboard token" : "Create token" }}
            </Button>
          </DialogFooter>
        </template>

        <template v-else>
          <TokenSecretReveal :token="fresh.token" :name="fresh.name" />
          <DialogFooter>
            <Button @click="showCreate = false">Done</Button>
          </DialogFooter>
        </template>
      </DialogContent>
    </Dialog>
  </div>
</template>
