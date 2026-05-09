<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useMutation, useQueryClient } from "@tanstack/vue-query";
import { Loader2 } from "lucide-vue-next";
import { toast } from "vue-sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { api } from "@/lib/api";

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{
  "update:open": [value: boolean];
  created: [project: { id: string; key: string; name: string }];
}>();

const qc = useQueryClient();

const newKey = ref("");
const newName = ref("");
const newDescription = ref("");

watch(() => props.open, (v) => {
  if (!v) return;
  newKey.value = "";
  newName.value = "";
  newDescription.value = "";
});

const validKey = computed(() => /^[A-Z][A-Z0-9]{1,9}$/.test(newKey.value.trim().toUpperCase()));
const canCreate = computed(() => validKey.value && newName.value.trim().length > 0);

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
  onSuccess: (data) => {
    qc.invalidateQueries({ queryKey: ["sw", "projects"] });
    toast.success(`Project ${newKey.value.trim().toUpperCase()} created`);
    emit("update:open", false);
    if (data) emit("created", data);
  },
});
</script>

<template>
  <Dialog :open="open" @update:open="(v) => emit('update:open', v)">
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

        <p v-if="newKey.trim() && !validKey" class="text-xs text-destructive">
          Key must start with a letter and be 2–10 uppercase alphanumerics.
        </p>
      </div>

      <DialogFooter>
        <Button variant="ghost" @click="emit('update:open', false)">Cancel</Button>
        <Button :disabled="!canCreate || createMutation.isPending.value" @click="createMutation.mutate()">
          <Loader2 v-if="createMutation.isPending.value" class="h-3.5 w-3.5 mr-1.5 animate-spin" />
          Create project
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
