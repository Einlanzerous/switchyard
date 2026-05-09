<script setup lang="ts">
import { computed } from "vue";
import { RouterView, useRoute, useRouter } from "vue-router";
import AppSidebar from "./AppSidebar.vue";
import AppTopbar from "./AppTopbar.vue";
import TicketDrawer from "@/components/tickets/TicketDrawer.vue";
import CreateTicketDialog from "@/components/tickets/CreateTicketDialog.vue";
import CommandPalette from "@/components/CommandPalette.vue";
import ShortcutSheet from "@/components/ShortcutSheet.vue";
import { useUiStore } from "@/stores/ui";
import { useShortcuts } from "@/composables/useShortcuts";

const ui = useUiStore();
const route = useRoute();
const router = useRouter();

// Project context for `c` (new ticket) — pull from /projects/:key/board route
// param if present, else from a single-project filter on /tickets, else null
// (the dialog will then default to the first project in the catalog).
const contextProjectKey = computed<string | null>(() => {
  const k = route.params.key;
  if (typeof k === "string" && k.length > 0) return k;
  const q = route.query.project;
  if (typeof q === "string") {
    const parts = q.split(",").map((s) => s.trim()).filter(Boolean);
    if (parts.length === 1) return parts[0]!;
  }
  return null;
});

useShortcuts({
  "ctrl+k": () => ui.togglePalette(),
  "meta+k": () => ui.togglePalette(),
  "c": () => ui.openCreateTicket(contextProjectKey.value),
  "?": () => ui.toggleShortcuts(),
  "g t": () => router.push("/tickets"),
  "g b": () => router.push("/boards"),
  "g p": () => router.push("/projects"),
  "g a": () => router.push("/automations"),
  "g s": () => router.push("/settings"),
});
</script>

<template>
  <div class="min-h-screen flex bg-background text-foreground">
    <AppSidebar />
    <div class="flex flex-1 flex-col min-w-0">
      <AppTopbar />
      <main class="flex-1 overflow-auto">
        <RouterView />
      </main>
    </div>
    <!-- Single global drawer instance. Any view that sets `?focus=KEY` in the
         URL pops the drawer open with that ticket. Lives at the shell level so
         we don't have to remember to mount it inside every list/board view. -->
    <TicketDrawer />

    <!-- Cross-cutting overlays. Driven by ui store actions / shortcuts so any
         view can trigger them without re-mounting their own copies. -->
    <CommandPalette />
    <ShortcutSheet />
    <CreateTicketDialog
      v-model:open="ui.createTicketOpen"
      :default-project-key="ui.createTicketDefaultProject"
    />
  </div>
</template>
