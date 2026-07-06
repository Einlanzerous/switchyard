// Cross-cutting UI state: dialogs/sheets that any view should be able to
// trigger (command palette, shortcut help, "new ticket" modal). Centralized
// in a Pinia store so a single instance is mounted in AppShell instead of
// every view re-mounting its own copy.

import { defineStore } from "pinia";
import { ref } from "vue";
import { useStorage } from "@vueuse/core";
import type { StatusCategory } from "@switchyard/shared";

export const useUiStore = defineStore("ui", () => {
  const paletteOpen = ref(false);
  const shortcutsOpen = ref(false);
  const createTicketOpen = ref(false);

  // Collapsed (icons-only) state for the left sidebar. Persisted to
  // localStorage (same `switchyard.*` convention as theme/token) so the
  // preference survives reloads.
  const sidebarCollapsed = useStorage("switchyard.sidebarCollapsed", false);
  function toggleSidebar() { sidebarCollapsed.value = !sidebarCollapsed.value; }

  // Carries optional context into the create-ticket dialog. The dialog itself
  // also falls back to the URL's `?project=` if this is null.
  const createTicketDefaultProject = ref<string | null>(null);
  // Optional status-category prefill — the board's per-column "+" quick-add
  // passes its column so the new ticket lands there instead of the default.
  const createTicketDefaultCategory = ref<StatusCategory | null>(null);

  function openPalette() { paletteOpen.value = true; }
  function closePalette() { paletteOpen.value = false; }
  function togglePalette() { paletteOpen.value = !paletteOpen.value; }

  function openShortcuts() { shortcutsOpen.value = true; }
  function toggleShortcuts() { shortcutsOpen.value = !shortcutsOpen.value; }

  function openCreateTicket(
    defaultProjectKey?: string | null,
    defaultCategory?: StatusCategory | null,
  ) {
    createTicketDefaultProject.value = defaultProjectKey ?? null;
    createTicketDefaultCategory.value = defaultCategory ?? null;
    createTicketOpen.value = true;
  }

  return {
    paletteOpen, shortcutsOpen, createTicketOpen, createTicketDefaultProject,
    createTicketDefaultCategory,
    sidebarCollapsed,
    openPalette, closePalette, togglePalette,
    openShortcuts, toggleShortcuts,
    openCreateTicket,
    toggleSidebar,
  };
});
