<script setup lang="ts">
import { computed, ref } from "vue";
import { RouterLink } from "vue-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/vue-query";
import { Plus, Loader2, ChevronRight, FolderKanban, Archive } from "lucide-vue-next";
import { toast } from "vue-sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { api } from "@/lib/api";
import { queryKeys } from "@/lib/queryKeys";

const qc = useQueryClient();

const projectsQuery = useQuery({
  queryKey: queryKeys.projects({ include_archived: true }),
  queryFn: async () => {
    const { data, error } = await api.GET("/v1/projects", {
      params: { query: { limit: 200, include_archived: true } },
    });
    if (error) throw error;
    return data;
  },
});
const items = computed(() => projectsQuery.data.value?.items ?? []);

const showCreate = ref(false);
const newKey = ref("");
const newName = ref("");
const newDescription = ref("");

function openCreate() {
  newKey.value = "";
  newName.value = "";
  newDescription.value = "";
  showCreate.value = true;
}

const createMutation = useMutation({
  mutationFn: async () => {
    const { data, error } = await api.POST("/v1/projects", {
      body: {
        key: newKey.value.trim().toUpperCase(),
        name: newName.value.trim(),
        description: newDescription.value.trim() || undefined,
      },
    });
    if (error) throw error;
    return data;
  },
  onSuccess: () => {
    qc.invalidateQueries({ queryKey: ["sw", "projects"] });
    toast.success(`Project ${newKey.value.trim().toUpperCase()} created`);
    showCreate.value = false;
  },
});

const validKey = computed(() => /^[A-Z][A-Z0-9]{1,9}$/.test(newKey.value.trim().toUpperCase()));
const canCreate = computed(() =>
  validKey.value && newName.value.trim().length > 0
);
</script>

<template>
  <div class="space-y-4">
    <header class="flex items-end justify-between gap-3">
      <div>
        <h2 class="text-xl font-semibold tracking-tight">Projects</h2>
        <p class="text-sm text-muted-foreground">
          Each project owns its own statuses, transitions, and ticket numbering.
          Project keys are immutable after creation.
        </p>
      </div>
      <Button size="sm" @click="openCreate">
        <Plus class="h-3.5 w-3.5 mr-1.5" /> New project
      </Button>
    </header>

    <Card>
      <CardContent class="p-0">
        <div v-if="projectsQuery.isLoading.value" class="p-4 space-y-2">
          <Skeleton v-for="n in 4" :key="n" class="h-12 w-full" />
        </div>
        <ul v-else-if="items.length > 0" class="divide-y">
          <RouterLink
            v-for="p in items"
            :key="p.id"
            :to="`/settings/projects/${p.key}`"
            custom
            v-slot="{ navigate }"
          >
            <li
              class="flex items-center gap-3 p-3 hover:bg-accent/40 cursor-pointer"
              @click="navigate"
            >
              <FolderKanban class="h-4 w-4 text-muted-foreground shrink-0" />
              <div class="flex-1 min-w-0">
                <div class="flex items-center gap-2">
                  <span class="font-mono text-xs text-muted-foreground">{{ p.key }}</span>
                  <span class="font-medium truncate">{{ p.name }}</span>
                  <Badge v-if="p.archived_at" variant="secondary" class="text-[10px]">
                    <Archive class="h-2.5 w-2.5 mr-0.5" /> archived
                  </Badge>
                </div>
                <div v-if="p.description" class="text-xs text-muted-foreground truncate mt-0.5">
                  {{ p.description }}
                </div>
              </div>
              <ChevronRight class="h-4 w-4 text-muted-foreground" />
            </li>
          </RouterLink>
        </ul>
        <p v-else class="p-6 text-sm text-muted-foreground text-center italic">
          No projects yet.
        </p>
      </CardContent>
    </Card>

    <Dialog v-model:open="showCreate">
      <DialogContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New project</DialogTitle>
          <DialogDescription>
            Pick a short uppercase key (e.g. SWY, FLOW). It prefixes ticket
            keys forever and can't be renamed.
          </DialogDescription>
        </DialogHeader>

        <div class="space-y-3">
          <div class="grid grid-cols-3 gap-3">
            <div class="space-y-1.5 col-span-1">
              <Label for="proj-key">Key</Label>
              <Input
                id="proj-key"
                v-model="newKey"
                placeholder="FLOW"
                maxlength="10"
                class="font-mono uppercase"
                autofocus
              />
            </div>
            <div class="space-y-1.5 col-span-2">
              <Label for="proj-name">Name</Label>
              <Input id="proj-name" v-model="newName" placeholder="Flow project" />
            </div>
          </div>

          <div class="space-y-1.5">
            <Label for="proj-desc">Description</Label>
            <textarea
              id="proj-desc"
              v-model="newDescription"
              rows="3"
              class="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring resize-y"
              placeholder="Optional"
            />
          </div>

          <p
            v-if="newKey.trim() && !validKey"
            class="text-xs text-destructive"
          >Key must start with a letter and be 2–10 uppercase alphanumerics.</p>
        </div>

        <DialogFooter>
          <Button variant="ghost" @click="showCreate = false">Cancel</Button>
          <Button :disabled="!canCreate || createMutation.isPending.value" @click="createMutation.mutate()">
            <Loader2 v-if="createMutation.isPending.value" class="h-3.5 w-3.5 mr-1.5 animate-spin" />
            Create project
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>
