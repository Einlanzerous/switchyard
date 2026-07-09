<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useMutation, useQuery, useQueryClient } from "@tanstack/vue-query";
import {
  Plus, Loader2, Trash2, Pencil, Bot, User as UserIcon, KeyRound, UserPlus, Crown,
} from "lucide-vue-next";
import { toast } from "vue-sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import UserAvatar from "@/components/UserAvatar.vue";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import TokenSecretReveal from "@/components/settings/TokenSecretReveal.vue";
import TokenScopePicker from "@/components/settings/TokenScopePicker.vue";
import ProjectRolePicker from "@/components/settings/ProjectRolePicker.vue";
import { useAuthStore } from "@/stores/auth";
import { api } from "@/lib/api";
import { queryKeys } from "@/lib/queryKeys";
import { defaultTokenScopes } from "@/lib/tokenScopes";
import type {
  User as UserType, UserType as UserTypeEnum, InstanceRole, ProjectRole, ApiTokenScope,
} from "@switchyard/shared";

const auth = useAuthStore();
const qc = useQueryClient();

const usersQuery = useQuery({
  queryKey: queryKeys.users(),
  queryFn: async () => {
    const { data, error } = await api.GET("/v1/users", { params: { query: { limit: 200 } } });
    if (error) throw error;
    return data;
  },
});
const items = computed(() => usersQuery.data.value?.items ?? []);

// Project names for the invite blurb (key → name). Shares the cache with the
// ProjectRolePicker's query, so no extra fetch.
const projectsQuery = useQuery({
  queryKey: queryKeys.projects(),
  staleTime: 5 * 60 * 1000,
  queryFn: async () => {
    const { data, error } = await api.GET("/v1/projects", { params: { query: { limit: 200 } } });
    if (error) throw error;
    return data;
  },
});
function projectName(key: string): string {
  return projectsQuery.data.value?.items.find((p) => p.key === key)?.name ?? key;
}

// ─── create / edit dialog ─────────────────────────────────────────────────────
const dialogOpen = ref(false);
const editing = ref<UserType | null>(null);
const draftName = ref("");
const draftType = ref<UserTypeEnum>("agent");
const draftIcon = ref("");
const draftRole = ref<InstanceRole>("member");
const draftEmail = ref("");

watch(dialogOpen, (v) => {
  if (!v) editing.value = null;
});

function openCreate() {
  editing.value = null;
  draftName.value = "";
  draftType.value = "agent";
  draftIcon.value = "";
  draftRole.value = "member";
  draftEmail.value = "";
  dialogOpen.value = true;
}

function openEdit(u: UserType) {
  editing.value = u;
  draftName.value = u.name;
  draftType.value = u.type;
  draftIcon.value = u.icon ?? "";
  draftRole.value = u.instance_role;
  draftEmail.value = u.email ?? "";
  dialogOpen.value = true;
}

const saveMutation = useMutation({
  mutationFn: async () => {
    const email = draftEmail.value.trim();
    const body = {
      name: draftName.value.trim(),
      type: draftType.value,
      icon: draftIcon.value.trim() || undefined,
      // Instance role only applies to humans; agents are instance-wide service
      // accounts and bypass it. Omit it for agents so we never flip their column.
      ...(draftType.value === "human" ? { instance_role: draftRole.value } : {}),
    };
    if (editing.value) {
      // null (not undefined) so clearing the field actually wipes the email.
      const { data, error } = await api.PATCH("/v1/users/{id}", {
        params: { path: { id: editing.value.id } },
        body: { ...body, email: email || null },
      });
      if (error) throw error;
      return data;
    }
    const { data, error } = await api.POST("/v1/users", {
      body: { ...body, email: email || undefined },
    });
    if (error) throw error;
    return data;
  },
  onSuccess: () => {
    qc.invalidateQueries({ queryKey: queryKeys.users() });
    if (editing.value?.id === auth.me?.id) {
      qc.invalidateQueries({ queryKey: queryKeys.usersMe() });
    }
    toast.success(editing.value ? "User updated" : "User created");
    dialogOpen.value = false;
  },
  onError: (err) => {
    toast.error((err as { error?: { message?: string } })?.error?.message ?? "Save failed");
  },
});

const deletingId = ref<string | null>(null);
const deleteMutation = useMutation({
  mutationFn: async (id: string) => {
    deletingId.value = id;
    const { error } = await api.DELETE("/v1/users/{id}", { params: { path: { id } } });
    if (error) throw error;
  },
  onSuccess: () => {
    qc.invalidateQueries({ queryKey: queryKeys.users() });
    toast.success("User deleted");
  },
  onSettled: () => { deletingId.value = null; },
});

// ─── invite wizard (create a human + mint their first token in one flow) ───────
const inviteOpen = ref(false);
const inviteName = ref("");
const inviteRole = ref<InstanceRole>("member");
const inviteScopes = ref<Set<ApiTokenScope>>(defaultTokenScopes());
// Per-project memberships to grant up front, keyed by project key. Only applies
// to members — owners see everything, so it's ignored when role === "owner".
const inviteProjects = ref<Record<string, ProjectRole>>({});
const inviteFresh = ref<{ token: string; name: string } | null>(null);
const inviteMessage = ref<string>("");

watch(inviteOpen, (v) => {
  if (v) {
    inviteName.value = "";
    inviteRole.value = "member";
    inviteScopes.value = defaultTokenScopes();
    inviteProjects.value = {};
    inviteFresh.value = null;
    inviteMessage.value = "";
  }
});

// A ready-to-paste blurb (Discord etc.) that explains the invitee's access and
// embeds the one-time login link. Built once the token exists.
function buildInviteMessage(token: string): string {
  const loginUrl = `${window.location.origin}/login?token=${token}`;
  let access: string;
  if (inviteRole.value === "owner") {
    access = "full access to every project (owner)";
  } else {
    const entries = Object.entries(inviteProjects.value);
    access = entries.length === 0
      ? "no projects yet — they'll be added later"
      : entries.map(([key, role]) => `${role} on ${projectName(key)}`).join(", ");
  }
  return [
    `You're invited to Switchyard 🚂`,
    `Access: ${access}`,
    `Sign in (this link logs you straight in):`,
    loginUrl,
    `⚠ Treat this link like a password — anyone with it can sign in as you.`,
  ].join("\n");
}

const inviteMutation = useMutation({
  mutationFn: async () => {
    const name = inviteName.value.trim();
    // 1. Create the human.
    const { data: user, error: createErr } = await api.POST("/v1/users", {
      body: { name, type: "human", instance_role: inviteRole.value },
    });
    if (createErr) throw createErr;
    if (!user) throw new Error("user create returned nothing");
    // 2. Assign per-project memberships (members only). Collect failures rather
    //    than aborting — the user + token still get created either way.
    const memberships = inviteRole.value === "member" ? Object.entries(inviteProjects.value) : [];
    const failures: string[] = [];
    for (const [key, role] of memberships) {
      const { error } = await api.POST("/v1/projects/{key}/members", {
        params: { path: { key } },
        body: { user_id: user.id, role },
      });
      if (error) failures.push(key);
    }
    // 3. Mint their first token (plaintext returned once → QR reveal).
    const { data: token, error: tokenErr } = await api.POST("/v1/users/{id}/tokens", {
      params: { path: { id: user.id } },
      body: { name, kind: "personal", scopes: Array.from(inviteScopes.value) },
    });
    if (tokenErr) throw tokenErr;
    return { token, failures };
  },
  onSuccess: ({ token, failures }) => {
    qc.invalidateQueries({ queryKey: queryKeys.users() });
    for (const key of Object.keys(inviteProjects.value)) {
      qc.invalidateQueries({ queryKey: queryKeys.projectMembers(key) });
    }
    if (failures.length > 0) {
      toast.error(`Created, but couldn't add to: ${failures.join(", ")} — add manually under the project's Members tab.`);
    }
    if (token?.token) {
      inviteFresh.value = { token: token.token, name: token.name };
      inviteMessage.value = buildInviteMessage(token.token);
    }
  },
  onError: (err) => {
    toast.error((err as { error?: { message?: string } })?.error?.message ?? "Invite failed");
  },
});

// ─── mint a token for an existing user ─────────────────────────────────────────
const mintOpen = ref(false);
const mintTarget = ref<UserType | null>(null);
const mintName = ref("");
const mintScopes = ref<Set<ApiTokenScope>>(defaultTokenScopes());
const mintFresh = ref<{ token: string; name: string } | null>(null);

function openMint(u: UserType) {
  mintTarget.value = u;
  mintName.value = "";
  mintScopes.value = defaultTokenScopes();
  mintFresh.value = null;
  mintOpen.value = true;
}

const mintMutation = useMutation({
  mutationFn: async () => {
    if (!mintTarget.value) throw new Error("no target");
    const { data, error } = await api.POST("/v1/users/{id}/tokens", {
      params: { path: { id: mintTarget.value.id } },
      body: { name: mintName.value.trim(), kind: "personal", scopes: Array.from(mintScopes.value) },
    });
    if (error) throw error;
    return data;
  },
  onSuccess: (data) => {
    if (mintTarget.value) qc.invalidateQueries({ queryKey: queryKeys.userTokens(mintTarget.value.id) });
    if (data?.token) mintFresh.value = { token: data.token, name: data.name };
  },
  onError: (err) => {
    toast.error((err as { error?: { message?: string } })?.error?.message ?? "Mint failed");
  },
});
</script>

<template>
  <div class="space-y-4">
    <header class="flex items-end justify-between gap-3">
      <div>
        <h2 class="text-xl font-semibold tracking-tight">Users</h2>
        <p class="text-sm text-muted-foreground">
          Humans and agents with switchyard accounts. Each agent gets its own
          token so audit trails attribute actions accurately.
        </p>
      </div>
      <div class="flex items-center gap-2">
        <Button size="sm" variant="outline" @click="openCreate">
          <Plus class="h-3.5 w-3.5 mr-1.5" /> New user
        </Button>
        <Button size="sm" @click="inviteOpen = true">
          <UserPlus class="h-3.5 w-3.5 mr-1.5" /> Invite person
        </Button>
      </div>
    </header>

    <Card>
      <CardContent class="p-0">
        <div v-if="usersQuery.isLoading.value" class="p-4 space-y-2">
          <Skeleton v-for="n in 4" :key="n" class="h-12 w-full" />
        </div>
        <ul v-else-if="items.length > 0" class="divide-y">
          <li v-for="u in items" :key="u.id" class="flex items-center gap-3 p-3">
            <UserAvatar :user="u" size="md" />
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-2">
                <span class="font-medium">{{ u.name }}</span>
                <span v-if="u.id === auth.me?.id" class="text-[10px] text-muted-foreground">(you)</span>
                <Badge
                  v-if="u.type === 'human' && u.instance_role === 'owner'"
                  variant="secondary"
                  class="text-[10px] gap-1"
                >
                  <Crown class="h-3 w-3" /> owner
                </Badge>
              </div>
              <div class="text-[11px] text-muted-foreground flex items-center gap-1">
                <component :is="u.type === 'agent' ? Bot : UserIcon" class="h-3 w-3" />
                {{ u.type === "human" ? u.instance_role : u.type }}
              </div>
            </div>
            <Button
              variant="ghost"
              size="sm"
              class="text-muted-foreground"
              :aria-label="`Mint token for ${u.name}`"
              title="Mint a token"
              @click="openMint(u)"
            >
              <KeyRound class="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              class="text-muted-foreground"
              :aria-label="`Edit user ${u.name}`"
              @click="openEdit(u)"
            >
              <Pencil class="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              class="text-muted-foreground hover:text-destructive"
              :disabled="deletingId === u.id || u.id === auth.me?.id"
              :title="u.id === auth.me?.id ? 'You can\'t delete yourself' : 'Delete user'"
              :aria-label="`Delete user ${u.name}`"
              @click="deleteMutation.mutate(u.id)"
            >
              <Loader2 v-if="deletingId === u.id" class="h-3.5 w-3.5 animate-spin" />
              <Trash2 v-else class="h-3.5 w-3.5" />
            </Button>
          </li>
        </ul>
        <p v-else class="p-6 text-sm text-muted-foreground text-center italic">
          No users.
        </p>
      </CardContent>
    </Card>

    <!-- Create / edit user -->
    <Dialog v-model:open="dialogOpen">
      <DialogContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{{ editing ? "Edit user" : "New user" }}</DialogTitle>
          <DialogDescription>
            Agent accounts are intended for n8n / scripts; human accounts are
            for the people on your team.
          </DialogDescription>
        </DialogHeader>
        <div class="space-y-3">
          <div class="space-y-1.5">
            <Label for="user-name">Name</Label>
            <Input id="user-name" v-model="draftName" maxlength="100" autofocus />
          </div>
          <div class="space-y-1.5">
            <Label>Type</Label>
            <Select v-model="draftType">
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="human">Human</SelectItem>
                <SelectItem value="agent">Agent</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div v-if="draftType === 'human'" class="space-y-1.5">
            <Label>Instance role</Label>
            <Select v-model="draftRole">
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="member">Member — scoped to their projects</SelectItem>
                <SelectItem value="owner">Owner — blanket access to everything</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div v-if="draftType === 'human'" class="space-y-1.5">
            <Label for="user-email">Email</Label>
            <Input
              id="user-email"
              v-model="draftEmail"
              type="email"
              maxlength="255"
              placeholder="Optional — for Cloudflare Access SSO"
            />
          </div>
          <div class="space-y-1.5">
            <Label for="user-icon">Avatar URL</Label>
            <Input id="user-icon" v-model="draftIcon" maxlength="500" placeholder="Optional" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" @click="dialogOpen = false">Cancel</Button>
          <Button
            :disabled="draftName.trim().length === 0 || saveMutation.isPending.value"
            @click="saveMutation.mutate()"
          >
            <Loader2 v-if="saveMutation.isPending.value" class="h-3.5 w-3.5 mr-1.5 animate-spin" />
            {{ editing ? "Save" : "Create" }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <!-- Invite a person: create human + mint first token, QR shown once -->
    <Dialog v-model:open="inviteOpen">
      <DialogContent class="sm:max-w-md">
        <template v-if="!inviteFresh">
          <DialogHeader>
            <DialogTitle>Invite a person</DialogTitle>
            <DialogDescription>
              Creates a human account and mints their first token in one step.
              The plaintext + QR are shown ONCE on the next screen — they scan it
              from <code class="font-mono">/login</code> on their device.
            </DialogDescription>
          </DialogHeader>
          <div class="space-y-3">
            <div class="space-y-1.5">
              <Label for="invite-name">Name</Label>
              <Input id="invite-name" v-model="inviteName" maxlength="100" placeholder="e.g. Alex" autofocus />
            </div>
            <div class="space-y-1.5">
              <Label>Instance role</Label>
              <Select v-model="inviteRole">
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="member">Member — scoped to their projects</SelectItem>
                  <SelectItem value="owner">Owner — blanket access to everything</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div v-if="inviteRole === 'member'" class="space-y-1.5">
              <Label>Projects</Label>
              <ProjectRolePicker v-model="inviteProjects" />
              <p class="text-[11px] text-muted-foreground">
                A member sees only the projects you add here. Leave empty to add
                them later under each project's Members tab.
              </p>
            </div>
            <div
              v-else
              class="flex items-start gap-2 rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground"
            >
              <Crown class="h-3.5 w-3.5 mt-0.5 shrink-0" />
              <span>Owners see every project — now and future — so there's nothing to assign.</span>
            </div>
            <div class="space-y-1.5">
              <Label>Token scopes</Label>
              <TokenScopePicker v-model="inviteScopes" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" @click="inviteOpen = false">Cancel</Button>
            <Button
              :disabled="
                inviteName.trim().length === 0
                || inviteScopes.size === 0
                || inviteMutation.isPending.value
              "
              @click="inviteMutation.mutate()"
            >
              <Loader2 v-if="inviteMutation.isPending.value" class="h-3.5 w-3.5 mr-1.5 animate-spin" />
              Create &amp; mint token
            </Button>
          </DialogFooter>
        </template>
        <template v-else>
          <TokenSecretReveal
            :token="inviteFresh.token"
            :name="inviteFresh.name"
            :message="inviteMessage"
          />
          <DialogFooter>
            <Button @click="inviteOpen = false">Done</Button>
          </DialogFooter>
        </template>
      </DialogContent>
    </Dialog>

    <!-- Mint a token for an existing user -->
    <Dialog v-model:open="mintOpen">
      <DialogContent class="sm:max-w-md">
        <template v-if="!mintFresh">
          <DialogHeader>
            <DialogTitle>Mint a token{{ mintTarget ? ` for ${mintTarget.name}` : "" }}</DialogTitle>
            <DialogDescription>
              The plaintext value is shown ONCE on the next screen.
            </DialogDescription>
          </DialogHeader>
          <div class="space-y-3">
            <div class="space-y-1.5">
              <Label for="mint-name">Token name</Label>
              <Input id="mint-name" v-model="mintName" placeholder="e.g. laptop 2026-06" autofocus />
            </div>
            <div class="space-y-1.5">
              <Label>Scopes</Label>
              <TokenScopePicker v-model="mintScopes" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" @click="mintOpen = false">Cancel</Button>
            <Button
              :disabled="
                mintName.trim().length === 0
                || mintScopes.size === 0
                || mintMutation.isPending.value
              "
              @click="mintMutation.mutate()"
            >
              <Loader2 v-if="mintMutation.isPending.value" class="h-3.5 w-3.5 mr-1.5 animate-spin" />
              Mint token
            </Button>
          </DialogFooter>
        </template>
        <template v-else>
          <TokenSecretReveal :token="mintFresh.token" :name="mintFresh.name" />
          <DialogFooter>
            <Button @click="mintOpen = false">Done</Button>
          </DialogFooter>
        </template>
      </DialogContent>
    </Dialog>
  </div>
</template>
