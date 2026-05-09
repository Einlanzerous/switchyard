<script setup lang="ts">
import { computed, ref } from "vue";
import { Search, X } from "lucide-vue-next";
import { Input } from "@/components/ui/input";
import type { Project } from "@switchyard/shared";

// Multi-select with search. Selected projects render as removable pills above
// the search input; the input filters the dropdown of unselected projects.
// Built on plain Input + filtered list rather than Popover/Command because:
// (1) we want the field always visible while users build their selection, and
// (2) we don't need full keyboard-navigation polish at this stage.

const props = defineProps<{
  modelValue: string[];          // selected project ids
  projects: Project[];
  loading?: boolean;
  // Cap the dropdown — large project lists shouldn't dominate the dialog.
  maxResults?: number;
}>();

const emit = defineEmits<{
  "update:modelValue": [value: string[]];
}>();

const search = ref("");
const focused = ref(false);

const selectedSet = computed(() => new Set(props.modelValue));

const selected = computed(() =>
  props.modelValue
    .map((id) => props.projects.find((p) => p.id === id))
    .filter((p): p is Project => !!p)
);

const filtered = computed(() => {
  const q = search.value.trim().toLowerCase();
  const out = props.projects.filter((p) => {
    if (selectedSet.value.has(p.id)) return false;
    if (!q) return true;
    return p.name.toLowerCase().includes(q) || p.key.toLowerCase().includes(q);
  });
  return out.slice(0, props.maxResults ?? 8);
});

function add(id: string) {
  if (selectedSet.value.has(id)) return;
  emit("update:modelValue", [...props.modelValue, id]);
  search.value = "";
}

function remove(id: string) {
  emit("update:modelValue", props.modelValue.filter((x) => x !== id));
}

// Dropdown shows when input is focused or has search text. Clicks inside the
// list intentionally don't blur the input (we use mousedown.prevent on the
// list buttons) so add() fires before we close.
const dropdownVisible = computed(() => focused.value || search.value.length > 0);
</script>

<template>
  <div class="space-y-2">
    <!-- Selected pills -->
    <div v-if="selected.length > 0" class="flex flex-wrap gap-1.5">
      <span
        v-for="p in selected"
        :key="p.id"
        class="inline-flex items-center gap-1 rounded-md border bg-muted/40 pl-2 pr-1 py-0.5 text-xs"
      >
        <span class="font-mono text-muted-foreground">{{ p.key }}</span>
        <span class="max-w-[10rem] truncate">{{ p.name }}</span>
        <button
          type="button"
          class="ml-0.5 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
          :aria-label="`Remove ${p.key}`"
          @click="remove(p.id)"
        >
          <X class="h-3 w-3" />
        </button>
      </span>
    </div>

    <!-- Search -->
    <div class="relative">
      <Search class="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
      <Input
        v-model="search"
        placeholder="Search projects to add…"
        class="pl-9 h-9"
        @focus="focused = true"
        @blur="focused = false"
      />

      <!-- Filtered results dropdown -->
      <div
        v-if="dropdownVisible && filtered.length > 0"
        class="absolute left-0 right-0 top-full mt-1 z-20 rounded-md border bg-popover shadow-md max-h-56 overflow-auto"
      >
        <button
          v-for="p in filtered"
          :key="p.id"
          type="button"
          class="flex w-full items-center gap-2 px-3 py-2 text-sm hover:bg-accent text-left"
          @mousedown.prevent="add(p.id)"
        >
          <span class="font-mono text-xs text-muted-foreground">{{ p.key }}</span>
          <span class="flex-1 truncate">{{ p.name }}</span>
        </button>
      </div>

      <!-- Empty hint while typing -->
      <div
        v-else-if="dropdownVisible && search.length > 0"
        class="absolute left-0 right-0 top-full mt-1 z-20 rounded-md border bg-popover px-3 py-2 text-xs text-muted-foreground italic shadow-sm"
      >
        {{ loading ? "Loading…" : "No matching projects." }}
      </div>
    </div>
  </div>
</template>
