<script setup lang="ts">
// Searchable multi-select of projects, each with a per-project role. Used by the
// invite wizard to drop a new member into specific projects up front. v-model is
// a { [projectKey]: ProjectRole } map — presence of a key means "selected".
// Built on Popover + Command so it scales to many projects (type to filter)
// instead of a wall of checkboxes.
import { computed, ref } from "vue";
import { Check, ChevronsUpDown, Plus, X } from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList,
} from "@/components/ui/command";
import { api } from "@/lib/api";
import { queryKeys } from "@/lib/queryKeys";
import { useQuery } from "@tanstack/vue-query";
import type { ProjectRole } from "@switchyard/shared";

const props = defineProps<{ modelValue: Record<string, ProjectRole> }>();
const emit = defineEmits<{ "update:modelValue": [Record<string, ProjectRole>] }>();

const open = ref(false);

const projectsQuery = useQuery({
  queryKey: queryKeys.projects(),
  staleTime: 5 * 60 * 1000,
  queryFn: async () => {
    const { data, error } = await api.GET("/v1/projects", { params: { query: { limit: 200 } } });
    if (error) throw error;
    return data;
  },
});
const projects = computed(() => projectsQuery.data.value?.items ?? []);
// The selected rows, in the projects' natural order, resolved back to name/key.
const selected = computed(() =>
  projects.value.filter((p) => p.key in props.modelValue),
);

function toggle(key: string) {
  const next = { ...props.modelValue };
  if (key in next) delete next[key];
  else next[key] = "viewer";
  emit("update:modelValue", next);
}

function setRole(key: string, role: ProjectRole) {
  emit("update:modelValue", { ...props.modelValue, [key]: role });
}
</script>

<template>
  <div class="space-y-2">
    <Popover v-model:open="open">
      <PopoverTrigger as-child>
        <Button variant="outline" role="combobox" class="w-full justify-between font-normal">
          <span class="flex items-center gap-1.5 text-muted-foreground">
            <Plus class="h-3.5 w-3.5" /> Add to projects…
          </span>
          <ChevronsUpDown class="h-3.5 w-3.5 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" class="w-72 p-0">
        <Command>
          <CommandInput placeholder="Search projects…" />
          <CommandList>
            <CommandEmpty>No projects found.</CommandEmpty>
            <CommandGroup>
              <CommandItem
                v-for="p in projects"
                :key="p.id"
                :value="`${p.key} ${p.name}`"
                class="cursor-pointer"
                @select="toggle(p.key)"
              >
                <Check
                  class="h-3.5 w-3.5"
                  :class="p.key in modelValue ? 'opacity-100' : 'opacity-0'"
                />
                <span class="font-mono text-xs text-muted-foreground">{{ p.key }}</span>
                <span class="flex-1 truncate">{{ p.name }}</span>
              </CommandItem>
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>

    <ul v-if="selected.length > 0" class="rounded-md border divide-y">
      <li v-for="p in selected" :key="p.id" class="flex items-center gap-2 px-3 py-2 text-sm">
        <span class="font-mono text-xs text-muted-foreground">{{ p.key }}</span>
        <span class="flex-1 truncate">{{ p.name }}</span>
        <Select
          :model-value="modelValue[p.key]"
          @update:model-value="(r) => setRole(p.key, r as ProjectRole)"
        >
          <SelectTrigger class="w-28 h-8"><SelectValue /></SelectTrigger>
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
          class="h-8 w-8 p-0 text-muted-foreground hover:text-destructive"
          :aria-label="`Remove ${p.name}`"
          @click="toggle(p.key)"
        >
          <X class="h-3.5 w-3.5" />
        </Button>
      </li>
    </ul>
  </div>
</template>
