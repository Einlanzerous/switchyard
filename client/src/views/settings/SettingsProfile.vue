<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useMutation, useQueryClient } from "@tanstack/vue-query";
import { Loader2 } from "lucide-vue-next";
import { toast } from "vue-sonner";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuthStore } from "@/stores/auth";
import { api } from "@/lib/api";
import { queryKeys } from "@/lib/queryKeys";

const auth = useAuthStore();
const qc = useQueryClient();

const name = ref("");
const icon = ref("");

// Initialize form fields from /me once it loads, and re-sync if it changes
// out from under us (e.g. an admin renames us in another tab).
watch(
  () => auth.me,
  (me) => {
    if (!me) return;
    name.value = me.name;
    icon.value = me.icon ?? "";
  },
  { immediate: true },
);

const initials = computed(() => {
  const v = name.value || auth.me?.name || "";
  return v.split(/\s+/).map((p) => p[0]?.toUpperCase() ?? "").slice(0, 2).join("");
});

const dirty = computed(() => {
  if (!auth.me) return false;
  return name.value !== auth.me.name || (icon.value || null) !== auth.me.icon;
});

const saveMutation = useMutation({
  mutationFn: async () => {
    if (!auth.me) throw new Error("not authenticated");
    const { data, error } = await api.PATCH("/v1/users/{id}", {
      params: { path: { id: auth.me.id } },
      body: {
        name: name.value.trim(),
        icon: icon.value.trim() ? icon.value.trim() : null,
      } as never,
    });
    if (error) throw error;
    return data;
  },
  onSuccess: () => {
    qc.invalidateQueries({ queryKey: queryKeys.usersMe() });
    qc.invalidateQueries({ queryKey: queryKeys.users() });
    toast.success("Profile updated");
  },
});
</script>

<template>
  <div class="space-y-4">
    <header>
      <h2 class="text-xl font-semibold tracking-tight">Profile</h2>
      <p class="text-sm text-muted-foreground">
        Your display name and avatar across the workspace.
      </p>
    </header>

    <Card>
      <CardHeader>
        <CardTitle class="text-base">Identity</CardTitle>
        <CardDescription>
          {{ auth.me?.type === "agent" ? "Agent account." : "Human account." }}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div v-if="!auth.me" class="space-y-3">
          <Skeleton class="h-12 w-12 rounded-full" />
          <Skeleton class="h-9 w-full" />
          <Skeleton class="h-9 w-full" />
        </div>
        <div v-else class="space-y-4">
          <div class="flex items-center gap-3">
            <Avatar class="h-12 w-12">
              <AvatarImage v-if="icon" :src="icon" :alt="name" />
              <AvatarFallback>{{ initials }}</AvatarFallback>
            </Avatar>
            <div class="text-xs text-muted-foreground font-mono">{{ auth.me.id }}</div>
          </div>

          <div class="space-y-1.5">
            <Label for="prof-name">Display name</Label>
            <Input id="prof-name" v-model="name" maxlength="100" />
          </div>

          <div class="space-y-1.5">
            <Label for="prof-icon">Avatar URL</Label>
            <Input
              id="prof-icon"
              v-model="icon"
              placeholder="https://example.com/avatar.png"
              maxlength="500"
            />
            <p class="text-xs text-muted-foreground">
              Optional. Falls back to initials when blank.
            </p>
          </div>

          <div class="flex items-center justify-end gap-2">
            <Button
              :disabled="!dirty || saveMutation.isPending.value"
              @click="saveMutation.mutate()"
            >
              <Loader2
                v-if="saveMutation.isPending.value"
                class="h-3.5 w-3.5 mr-1.5 animate-spin"
              />
              Save changes
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  </div>
</template>
