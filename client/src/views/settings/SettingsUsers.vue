<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useMutation, useQuery, useQueryClient } from "@tanstack/vue-query";
import { Plus, Loader2, Trash2, Pencil, Bot, User as UserIcon } from "lucide-vue-next";
import { toast } from "vue-sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { useAuthStore } from "@/stores/auth";
import { api } from "@/lib/api";
import { queryKeys } from "@/lib/queryKeys";
import type { User as UserType, UserType as UserTypeEnum } from "@switchyard/shared";

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

// Dialog state for both create + edit.
const dialogOpen = ref(false);
const editing = ref<UserType | null>(null);
const draftName = ref("");
const draftType = ref<UserTypeEnum>("agent");
const draftIcon = ref("");

watch(dialogOpen, (v) => {
  if (!v) editing.value = null;
});

function openCreate() {
  editing.value = null;
  draftName.value = "";
  draftType.value = "agent";
  draftIcon.value = "";
  dialogOpen.value = true;
}

function openEdit(u: UserType) {
  editing.value = u;
  draftName.value = u.name;
  draftType.value = u.type;
  draftIcon.value = u.icon ?? "";
  dialogOpen.value = true;
}

const saveMutation = useMutation({
  mutationFn: async () => {
    const body = {
      name: draftName.value.trim(),
      type: draftType.value,
      icon: draftIcon.value.trim() || undefined,
    };
    if (editing.value) {
      const { data, error } = await api.PATCH("/v1/users/{id}", {
        params: { path: { id: editing.value.id } },
        body,
      });
      if (error) throw error;
      return data;
    }
    const { data, error } = await api.POST("/v1/users", { body });
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

function initials(u: UserType) {
  return u.name.split(/\s+/).map((p) => p[0]?.toUpperCase() ?? "").slice(0, 2).join("");
}
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
      <Button size="sm" @click="openCreate">
        <Plus class="h-3.5 w-3.5 mr-1.5" /> New user
      </Button>
    </header>

    <Card>
      <CardContent class="p-0">
        <div v-if="usersQuery.isLoading.value" class="p-4 space-y-2">
          <Skeleton v-for="n in 4" :key="n" class="h-12 w-full" />
        </div>
        <ul v-else-if="items.length > 0" class="divide-y">
          <li v-for="u in items" :key="u.id" class="flex items-center gap-3 p-3">
            <Avatar class="h-7 w-7">
              <AvatarImage v-if="u.icon" :src="u.icon" :alt="u.name" />
              <AvatarFallback class="text-[10px]">{{ initials(u) }}</AvatarFallback>
            </Avatar>
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-2">
                <span class="font-medium">{{ u.name }}</span>
                <span v-if="u.id === auth.me?.id" class="text-[10px] text-muted-foreground">(you)</span>
              </div>
              <div class="text-[11px] text-muted-foreground flex items-center gap-1">
                <component :is="u.type === 'agent' ? Bot : UserIcon" class="h-3 w-3" />
                {{ u.type }}
              </div>
            </div>
            <Button variant="ghost" size="sm" class="text-muted-foreground" @click="openEdit(u)">
              <Pencil class="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              class="text-muted-foreground hover:text-destructive"
              :disabled="deletingId === u.id || u.id === auth.me?.id"
              :title="u.id === auth.me?.id ? 'You can\'t delete yourself' : 'Delete user'"
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
          <div class="space-y-1.5">
            <Label for="user-icon">Avatar URL</Label>
            <Input id="user-icon" v-model="draftIcon" maxlength="500" placeholder="Optional" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" @click="dialogOpen = false">Cancel</Button>
          <Button
            :disabled="
              draftName.trim().length === 0 || saveMutation.isPending.value
            "
            @click="saveMutation.mutate()"
          >
            <Loader2 v-if="saveMutation.isPending.value" class="h-3.5 w-3.5 mr-1.5 animate-spin" />
            {{ editing ? "Save" : "Create" }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>
