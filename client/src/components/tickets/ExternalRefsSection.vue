<script setup lang="ts">
import { ref, computed } from "vue";
import { Link2, Plus, X, Loader2 } from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import ExternalRefBadge from "./ExternalRefBadge.vue";
import type { ExternalRef } from "@switchyard/shared";

const props = defineProps<{
  refs: ExternalRef[];
  adding?: boolean;
  removingId?: string | null;
}>();

const emit = defineEmits<{
  add: [url: string];
  remove: [id: string];
}>();

const formOpen = ref(false);
const formUrl = ref("");

const canSubmit = computed(() => formUrl.value.trim().length > 0 && !props.adding);

function submit() {
  if (!canSubmit.value) return;
  emit("add", formUrl.value.trim());
  formUrl.value = "";
}

function reset() {
  formOpen.value = false;
  formUrl.value = "";
}

// Title fallback: pretty-shorten the URL when no fetched title is set.
function displayTitle(r: ExternalRef): string {
  if (r.title) return r.title;
  try {
    const u = new URL(r.url);
    return u.hostname + u.pathname;
  } catch {
    return r.url;
  }
}

// State pill — colored chip with bold label. PR `closed` (closed without
// merge) is treated as REJECTED for visual emphasis; for issues, `closed`
// still uses the rejected styling but the surrounding kind icon
// disambiguates (issue closed = resolved is still uncommon enough that
// red-on-icon-only is the right read). Build errors / Action failures
// share the rejected tone.
function stateLabel(state: string): string {
  if (state === "merged") return "Merged";
  if (state === "open") return "Open";
  if (state === "closed") return "Closed";
  if (state === "success") return "Success";
  if (state === "failed") return "Failed";
  return state.toUpperCase();
}

function statePillClass(state: string): string {
  if (state === "merged") {
    return "bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/30";
  }
  if (state === "open" || state === "success") {
    return "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30";
  }
  if (state === "closed" || state === "failed") {
    return "bg-red-500/15 text-red-600 dark:text-red-400 border-red-500/30";
  }
  return "bg-muted text-muted-foreground border-border";
}
</script>

<template>
  <section class="space-y-2">
    <div class="flex items-center gap-2 text-xs text-muted-foreground">
      <Link2 class="h-3.5 w-3.5" />
      <span>External references ({{ refs.length }})</span>
      <button
        v-if="!formOpen"
        type="button"
        class="inline-flex items-center gap-1 rounded-md border border-dashed px-1.5 h-5 text-[10px] text-muted-foreground hover:text-foreground hover:border-foreground/40 transition-colors"
        @click="formOpen = true"
      >
        <Plus class="h-2.5 w-2.5" /> Add
      </button>
    </div>

    <ul v-if="refs.length > 0" class="space-y-1">
      <li v-for="r in refs" :key="r.id" class="group">
        <div class="flex w-full items-center gap-2 rounded-md border bg-card px-2.5 py-1.5 text-sm">
          <ExternalRefBadge :value="r" />
          <a
            :href="r.url"
            target="_blank"
            rel="noopener noreferrer"
            class="flex-1 min-w-0 truncate text-left hover:text-foreground transition-colors"
          >{{ displayTitle(r) }}</a>
          <span
            v-if="r.state"
            :class="['inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider', statePillClass(r.state)]"
          >
            {{ stateLabel(r.state) }}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            class="opacity-0 group-hover:opacity-100 -my-1 h-6 w-6 p-0 text-muted-foreground hover:text-destructive"
            :disabled="removingId === r.id"
            :title="`Detach ${r.url}`"
            @click="$emit('remove', r.id)"
          >
            <Loader2 v-if="removingId === r.id" class="h-3 w-3 animate-spin" />
            <X v-else class="h-3 w-3" />
          </Button>
        </div>
      </li>
    </ul>
    <p v-else-if="!formOpen" class="text-xs text-muted-foreground italic">
      No external references. Paste a GitHub PR / issue / commit / Actions URL to attach one.
    </p>

    <form
      v-if="formOpen"
      class="grid grid-cols-[1fr_auto_auto] gap-2 items-center"
      @submit.prevent="submit"
    >
      <Input
        v-model="formUrl"
        placeholder="https://github.com/owner/repo/pull/42"
        class="text-xs font-mono"
        autofocus
      />
      <Button type="submit" size="sm" :disabled="!canSubmit" class="h-8">
        <Loader2 v-if="adding" class="h-3 w-3 mr-1 animate-spin" />
        Attach
      </Button>
      <Button type="button" variant="ghost" size="sm" class="h-8 px-2 text-muted-foreground" @click="reset">
        Cancel
      </Button>
    </form>
  </section>
</template>
