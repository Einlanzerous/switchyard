<script setup lang="ts">
// Floating popover for the @mention autocomplete. Anchored below its
// parent textarea via `top-full`. The mousedown.prevent on each item is
// load-bearing — without it the textarea blurs before the click fires
// (see the close timeout in useMentionAutocomplete.onBlur).

import UserAvatar from "@/components/UserAvatar.vue";
import type { UserRef } from "@switchyard/shared";

defineProps<{
  open: boolean;
  users: UserRef[];
  selectedIndex: number;
}>();

const emit = defineEmits<{ pick: [user: UserRef] }>();
</script>

<template>
  <div
    v-if="open && users.length > 0"
    class="absolute left-2 top-full mt-1 z-30 w-64 rounded-md border bg-popover shadow-md shadow-black/10 py-1 text-sm"
    role="listbox"
  >
    <button
      v-for="(u, i) in users"
      :key="u.id"
      type="button"
      role="option"
      :aria-selected="i === selectedIndex"
      class="flex items-center gap-2 w-full px-2 py-1.5 text-left transition-colors"
      :class="i === selectedIndex ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent/40 hover:text-foreground'"
      @mousedown.prevent="emit('pick', u)"
    >
      <UserAvatar :user="u" size="xs" class="shrink-0" />
      <span class="truncate">{{ u.name }}</span>
      <span class="ml-auto text-[10px] text-muted-foreground/70 shrink-0">{{ u.type }}</span>
    </button>
  </div>
</template>
