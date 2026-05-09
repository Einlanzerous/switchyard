// Cross-cutting UI state: dialogs/sheets that any view should be able to
// trigger (command palette, shortcut help, "new ticket" modal). Centralized
// in a Pinia store so a single instance is mounted in AppShell instead of
// every view re-mounting its own copy.

import { defineStore } from "pinia";
import { ref } from "vue";

export const useUiStore = defineStore("ui", () => {
  const paletteOpen = ref(false);
  const shortcutsOpen = ref(false);
  const createTicketOpen = ref(false);

  // Carries optional context into the create-ticket dialog. The dialog itself
  // also falls back to the URL's `?project=` if this is null.
  const createTicketDefaultProject = ref<string | null>(null);

  function openPalette() { paletteOpen.value = true; }
  function closePalette() { paletteOpen.value = false; }
  function togglePalette() { paletteOpen.value = !paletteOpen.value; }

  function openShortcuts() { shortcutsOpen.value = true; }
  function toggleShortcuts() { shortcutsOpen.value = !shortcutsOpen.value; }

  function openCreateTicket(defaultProjectKey?: string | null) {
    createTicketDefaultProject.value = defaultProjectKey ?? null;
    createTicketOpen.value = true;
  }

  return {
    paletteOpen, shortcutsOpen, createTicketOpen, createTicketDefaultProject,
    openPalette, closePalette, togglePalette,
    openShortcuts, toggleShortcuts,
    openCreateTicket,
  };
});
