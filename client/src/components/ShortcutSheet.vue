<script setup lang="ts">
import { computed } from "vue";
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { useUiStore } from "@/stores/ui";

const ui = useUiStore();

const open = computed({
  get: () => ui.shortcutsOpen,
  set: (v) => ui.shortcutsOpen = v,
});

// Keep this list and useShortcuts/handlers wiring in sync. The kbd chips
// double as both documentation and a visual sanity check that we mapped
// what we said we mapped.
type Group = { label: string; items: { keys: string[]; description: string }[] };

const groups: Group[] = [
  {
    label: "Global",
    items: [
      { keys: ["Ctrl", "K"], description: "Open command palette" },
      { keys: ["c"], description: "Create ticket" },
      { keys: ["?"], description: "Show this shortcut sheet" },
    ],
  },
  {
    label: "Navigation",
    items: [
      { keys: ["g", "t"], description: "Go to tickets" },
      { keys: ["g", "b"], description: "Go to boards" },
      { keys: ["g", "p"], description: "Go to projects" },
      { keys: ["g", "a"], description: "Go to automations" },
      { keys: ["g", "s"], description: "Go to settings" },
    ],
  },
  {
    label: "Forms",
    items: [
      { keys: ["Ctrl", "Enter"], description: "Submit (in editors and composers)" },
      { keys: ["Esc"], description: "Cancel / close" },
    ],
  },
];
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>Keyboard shortcuts</DialogTitle>
        <DialogDescription>
          Press <kbd class="rounded border bg-muted px-1 font-mono text-[10px]">?</kbd>
          anywhere to bring this back up.
        </DialogDescription>
      </DialogHeader>

      <div class="space-y-4">
        <section v-for="g in groups" :key="g.label" class="space-y-2">
          <h3 class="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            {{ g.label }}
          </h3>
          <ul class="space-y-1.5 text-sm">
            <li
              v-for="item in g.items"
              :key="item.description"
              class="flex items-center justify-between gap-3"
            >
              <span class="text-muted-foreground">{{ item.description }}</span>
              <span class="inline-flex items-center gap-1">
                <kbd
                  v-for="(k, i) in item.keys"
                  :key="i"
                  class="rounded border bg-muted/40 px-1.5 py-0.5 font-mono text-[10px] text-foreground"
                >{{ k }}</kbd>
              </span>
            </li>
          </ul>
        </section>
      </div>
    </DialogContent>
  </Dialog>
</template>
