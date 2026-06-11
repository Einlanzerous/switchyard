<script setup lang="ts">
// Shown on a project surface (tickets list / board) when the current user has
// read-only (`viewer`) access — the visible half of the 6.5/6.6 write gating.
// The server enforces write isolation regardless; this just sets expectations
// so a viewer isn't surprised by missing create/edit controls.
import { Eye } from "lucide-vue-next";
</script>

<template>
  <!-- @vue-expect-error this Vue version's DOM types don't include a data-* index signature for dynamic binds -->
  <div
    :data-testid="'readonly-banner'"
    class="flex items-center gap-2 border-b bg-muted/40 px-4 py-1.5 text-xs text-muted-foreground"
  >
    <Eye class="h-3.5 w-3.5 shrink-0" />
    <span>Read-only — you have <strong>viewer</strong> access to this project.</span>
  </div>
</template>
