<script setup lang="ts">
// Members sub-tab of the project Setup page (6.4). Project-admins + owners add
// people to the project, set their role (viewer/user/editor/admin), and remove them.
// The tab is gated upstream in ProjectSetupView on `my_role === 'admin' ||
// isOwner`; this view still degrades gracefully if the API forbids the read.
import { computed, ref } from "vue";
import { useMutation, useQuery, useQueryClient } from "@tanstack/vue-query";
import { Loader2, Trash2, UserPlus, ShieldAlert } from "lucide-vue-next";
import { toast } from "vue-sonner";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import UserAvatar from "@/components/UserAvatar.vue";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { api } from "@/lib/api";
import { queryKeys } from "@/lib/queryKeys";
import type { ProjectRole } from "@switchyard/shared";

const props = defineProps<{ projectKey: string }>();
const qc = useQueryClient();

const membersQuery = useQuery({
  queryKey: computed(() => queryKeys.projectMembers(props.projectKey)),
  enabled: computed(() => props.projectKey.length > 0),
  retry: false,
  queryFn: async () => {
    const { data, error } = await api.GET("/v1/projects/{key}/members", {
      params: { path: { key: props.projectKey } },
    });
    if (error) throw error;
    return data;
  },
});
const members = computed(() => membersQuery.data.value?.items ?? []);
// 403 (member but not admin) or 404 (non-member) → the gate failed open; show a
// restricted notice rather than an empty table.
const forbidden = computed(() => {
  const code = (membersQuery.error.value as { error?: { code?: string } } | null)?.error?.code;
  return code === "forbidden" || code === "not_found";
});

// Directory for the add-member picker: humans not already on the project.
const usersQuery = useQuery({
  queryKey: queryKeys.users(),
  queryFn: async () => {
    const { data, error } = await api.GET("/v1/users", { params: { query: { limit: 200 } } });
    if (error) throw error;
    return data;
  },
});
const candidates = computed(() => {
  const memberIds = new Set(members.value.map((m) => m.user.id));
  return (usersQuery.data.value?.items ?? []).filter(
    (u) => u.type === "human" && !memberIds.has(u.id),
  );
});

// ─── add member ───────────────────────────────────────────────────────────────
const addUserId = ref<string>("");
const addRole = ref<ProjectRole>("viewer");

const addMutation = useMutation({
  mutationFn: async () => {
    const { error } = await api.POST("/v1/projects/{key}/members", {
      params: { path: { key: props.projectKey } },
      body: { user_id: addUserId.value, role: addRole.value },
    });
    if (error) throw error;
  },
  onSuccess: () => {
    qc.invalidateQueries({ queryKey: queryKeys.projectMembers(props.projectKey) });
    addUserId.value = "";
    addRole.value = "viewer";
    toast.success("Member added");
  },
  onError: (err) => {
    toast.error((err as { error?: { message?: string } })?.error?.message ?? "Couldn't add member");
  },
});

// ─── change role ──────────────────────────────────────────────────────────────
const roleMutation = useMutation({
  mutationFn: async ({ userId, role }: { userId: string; role: ProjectRole }) => {
    const { error } = await api.PATCH("/v1/projects/{key}/members/{userId}", {
      params: { path: { key: props.projectKey, userId } },
      body: { role },
    });
    if (error) throw error;
  },
  onSuccess: () => {
    qc.invalidateQueries({ queryKey: queryKeys.projectMembers(props.projectKey) });
    toast.success("Role updated");
  },
  onError: (err) => {
    qc.invalidateQueries({ queryKey: queryKeys.projectMembers(props.projectKey) });
    toast.error((err as { error?: { message?: string } })?.error?.message ?? "Couldn't update role");
  },
});

// ─── remove member ────────────────────────────────────────────────────────────
const removingId = ref<string | null>(null);
const removeMutation = useMutation({
  mutationFn: async (userId: string) => {
    removingId.value = userId;
    const { error } = await api.DELETE("/v1/projects/{key}/members/{userId}", {
      params: { path: { key: props.projectKey, userId } },
    });
    if (error) throw error;
  },
  onSuccess: () => {
    qc.invalidateQueries({ queryKey: queryKeys.projectMembers(props.projectKey) });
    toast.success("Member removed");
  },
  onError: (err) => {
    toast.error((err as { error?: { message?: string } })?.error?.message ?? "Couldn't remove member");
  },
  onSettled: () => { removingId.value = null; },
});
</script>

<template>
  <div class="px-4 py-4 space-y-4 max-w-2xl">
    <div v-if="membersQuery.isLoading.value" class="space-y-3">
      <Skeleton class="h-32 w-full" />
    </div>

    <div
      v-else-if="forbidden"
      class="flex items-start gap-2 rounded-md border bg-muted/40 px-4 py-3 text-sm text-muted-foreground"
    >
      <ShieldAlert class="h-4 w-4 mt-0.5 shrink-0" />
      <span>Managing members requires <strong>project-admin</strong> access to this project.</span>
    </div>

    <template v-else>
      <!-- Add member -->
      <Card>
        <CardContent class="p-4 space-y-3">
          <div class="space-y-1.5">
            <Label>Add member</Label>
            <div class="flex items-center gap-2">
              <Select v-model="addUserId">
                <SelectTrigger class="flex-1">
                  <SelectValue placeholder="Select a person…" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem v-for="u in candidates" :key="u.id" :value="u.id">
                    {{ u.name }}
                  </SelectItem>
                </SelectContent>
              </Select>
              <Select v-model="addRole">
                <SelectTrigger class="w-32"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="viewer">Viewer</SelectItem>
                  <SelectItem value="user">User</SelectItem>
                  <SelectItem value="editor">Editor</SelectItem>
                  <SelectItem value="admin">Admin</SelectItem>
                </SelectContent>
              </Select>
              <Button
                :disabled="!addUserId || addMutation.isPending.value"
                @click="addMutation.mutate()"
              >
                <Loader2 v-if="addMutation.isPending.value" class="h-3.5 w-3.5 mr-1.5 animate-spin" />
                <UserPlus v-else class="h-3.5 w-3.5 mr-1.5" />
                Add
              </Button>
            </div>
            <p v-if="candidates.length === 0" class="text-[11px] text-muted-foreground">
              Everyone is already a member. Create new people under Settings → Users.
            </p>
          </div>
        </CardContent>
      </Card>

      <!-- Member list -->
      <Card>
        <CardContent class="p-0">
          <ul v-if="members.length > 0" class="divide-y">
            <li v-for="m in members" :key="m.user.id" class="flex items-center gap-3 p-3">
              <UserAvatar :user="m.user" size="md" />
              <div class="flex-1 min-w-0">
                <span class="font-medium">{{ m.user.name }}</span>
              </div>
              <Select
                :model-value="m.role"
                @update:model-value="(role) => roleMutation.mutate({ userId: m.user.id, role: role as ProjectRole })"
              >
                <SelectTrigger class="w-32"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="viewer">Viewer</SelectItem>
                  <SelectItem value="user">User</SelectItem>
                  <SelectItem value="editor">Editor</SelectItem>
                  <SelectItem value="admin">Admin</SelectItem>
                </SelectContent>
              </Select>
              <Button
                variant="ghost"
                size="sm"
                class="text-muted-foreground hover:text-destructive"
                :disabled="removingId === m.user.id"
                :aria-label="`Remove ${m.user.name}`"
                @click="removeMutation.mutate(m.user.id)"
              >
                <Loader2 v-if="removingId === m.user.id" class="h-3.5 w-3.5 animate-spin" />
                <Trash2 v-else class="h-3.5 w-3.5" />
              </Button>
            </li>
          </ul>
          <p v-else class="p-6 text-sm text-muted-foreground text-center italic">
            No members yet. Owners and agents always have access; add people here
            to scope them to this project.
          </p>
        </CardContent>
      </Card>
    </template>
  </div>
</template>
