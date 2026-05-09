<script setup lang="ts">
import { computed, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/vue-query";
import { ArrowLeft, Plus, Loader2, Trash2, ArrowRight } from "lucide-vue-next";
import { toast } from "vue-sonner";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import StatusBadge from "@/components/tickets/StatusBadge.vue";
import { api } from "@/lib/api";
import { queryKeys } from "@/lib/queryKeys";

const route = useRoute();
const router = useRouter();
const qc = useQueryClient();

const projectKey = computed(() => {
  const v = route.params.key;
  return typeof v === "string" ? v : "";
});

const statusesQuery = useQuery({
  queryKey: computed(() => queryKeys.projectStatuses(projectKey.value)),
  enabled: computed(() => projectKey.value.length > 0),
  queryFn: async () => {
    const { data, error } = await api.GET("/v1/projects/{key}/statuses", {
      params: { path: { key: projectKey.value } },
    });
    if (error) throw error;
    return data;
  },
});

const transitionsQuery = useQuery({
  queryKey: computed(() => queryKeys.projectTransitions(projectKey.value)),
  enabled: computed(() => projectKey.value.length > 0),
  queryFn: async () => {
    const { data, error } = await api.GET("/v1/projects/{key}/transitions", {
      params: { path: { key: projectKey.value } },
    });
    if (error) throw error;
    return data;
  },
});

const statuses = computed(() => statusesQuery.data.value?.items ?? []);
const transitions = computed(() => transitionsQuery.data.value?.items ?? []);

function statusById(id: string | null) {
  if (!id) return null;
  return statuses.value.find((s) => s.id === id) ?? null;
}

const ANY = "__any__";
const draftFrom = ref<string>(ANY);
const draftTo = ref<string>("");

const addMutation = useMutation({
  mutationFn: async () => {
    const { data, error } = await api.POST("/v1/projects/{key}/transitions", {
      params: { path: { key: projectKey.value } },
      body: {
        from_status_id: draftFrom.value === ANY ? null : draftFrom.value,
        to_status_id: draftTo.value,
      },
    });
    if (error) throw error;
    return data;
  },
  onSuccess: () => {
    qc.invalidateQueries({ queryKey: queryKeys.projectTransitions(projectKey.value) });
    toast.success("Transition added");
    draftFrom.value = ANY;
    draftTo.value = "";
  },
});

const deletingId = ref<string | null>(null);
const deleteMutation = useMutation({
  mutationFn: async (id: string) => {
    deletingId.value = id;
    const { error } = await api.DELETE("/v1/projects/{key}/transitions/{id}", {
      params: { path: { key: projectKey.value, id } },
    });
    if (error) throw error;
  },
  onSuccess: () => {
    qc.invalidateQueries({ queryKey: queryKeys.projectTransitions(projectKey.value) });
    toast.success("Transition removed");
  },
  onSettled: () => { deletingId.value = null; },
});

const canAdd = computed(() => draftTo.value.length > 0);
</script>

<template>
  <div class="space-y-4">
    <Button
      variant="ghost"
      size="sm"
      class="-ml-2 text-muted-foreground"
      @click="router.push(`/settings/projects/${projectKey}`)"
    >
      <ArrowLeft class="h-3.5 w-3.5 mr-1" /> {{ projectKey }}
    </Button>

    <header>
      <h2 class="text-xl font-semibold tracking-tight">Transitions</h2>
      <p class="text-sm text-muted-foreground">
        Restrict which status changes are allowed. With <strong>zero</strong>
        transitions defined, anything is allowed (the default). Adding any rules
        switches to whitelist mode — only listed transitions go through.
      </p>
    </header>

    <Card>
      <CardContent class="space-y-3 p-4">
        <div class="grid grid-cols-1 sm:grid-cols-[1fr_auto_1fr_auto] items-end gap-2">
          <div class="space-y-1.5">
            <Label>From</Label>
            <Select v-model="draftFrom">
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem :value="ANY">Any status</SelectItem>
                <SelectItem v-for="s in statuses" :key="s.id" :value="s.id">
                  {{ s.display_name }}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
          <ArrowRight class="h-4 w-4 text-muted-foreground self-center hidden sm:inline" />
          <div class="space-y-1.5">
            <Label>To</Label>
            <Select v-model="draftTo">
              <SelectTrigger><SelectValue placeholder="Pick a status" /></SelectTrigger>
              <SelectContent>
                <SelectItem v-for="s in statuses" :key="s.id" :value="s.id">
                  {{ s.display_name }}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
          <Button
            size="sm"
            :disabled="!canAdd || addMutation.isPending.value"
            @click="addMutation.mutate()"
          >
            <Loader2 v-if="addMutation.isPending.value" class="h-3.5 w-3.5 mr-1.5 animate-spin" />
            <Plus v-else class="h-3.5 w-3.5 mr-1.5" />
            Add
          </Button>
        </div>
      </CardContent>
    </Card>

    <Card>
      <CardContent class="p-0">
        <div v-if="transitionsQuery.isLoading.value" class="p-4 space-y-2">
          <Skeleton v-for="n in 3" :key="n" class="h-10 w-full" />
        </div>
        <ul v-else-if="transitions.length > 0" class="divide-y">
          <li
            v-for="t in transitions"
            :key="t.id"
            class="flex items-center gap-3 p-3"
          >
            <template v-if="statusById(t.from_status_id)">
              <StatusBadge
                :category="statusById(t.from_status_id)!.category"
                :display-name="statusById(t.from_status_id)!.display_name"
                size="sm"
              />
            </template>
            <span v-else class="text-xs text-muted-foreground italic">Any status</span>
            <ArrowRight class="h-3.5 w-3.5 text-muted-foreground" />
            <StatusBadge
              v-if="statusById(t.to_status_id)"
              :category="statusById(t.to_status_id)!.category"
              :display-name="statusById(t.to_status_id)!.display_name"
              size="sm"
            />
            <span class="flex-1" />
            <Button
              variant="ghost"
              size="sm"
              class="text-muted-foreground hover:text-destructive"
              :disabled="deletingId === t.id"
              @click="deleteMutation.mutate(t.id)"
            >
              <Loader2 v-if="deletingId === t.id" class="h-3.5 w-3.5 animate-spin" />
              <Trash2 v-else class="h-3.5 w-3.5" />
            </Button>
          </li>
        </ul>
        <p
          v-else
          class="p-4 text-sm text-muted-foreground italic text-center"
        >
          No transitions defined — any status change is allowed.
        </p>
      </CardContent>
    </Card>
  </div>
</template>
