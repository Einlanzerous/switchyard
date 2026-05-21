<script setup lang="ts">
import { ref, computed } from "vue";
import { CornerUpLeft, Layers, Link2, Plus, X, Loader2 } from "lucide-vue-next";
import StatusBadge from "./StatusBadge.vue";
import TypeIcon from "./TypeIcon.vue";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type {
  Ticket, TicketSummary, TicketLink, TicketLinkType, TicketLinkDirection,
} from "@switchyard/shared";

const props = defineProps<{
  parent: Ticket | null;
  parentLoading?: boolean;
  children: TicketSummary[];
  childrenLoading?: boolean;
  // If this ticket is itself an epic, we always render the children section
  // (even when empty) so the user knows where to add sub-tasks. For non-epics
  // we only render this whole component if parent is set.
  isEpic: boolean;
  links: TicketLink[];
  addingLink?: boolean;
  removingLinkId?: string | null;
}>();

const emit = defineEmits<{
  navigate: [key: string];
  "add-link": [payload: { type: TicketLinkType; target: string }];
  "remove-link": [linkId: string];
}>();

// Verb table: (type, direction) → human label. The link row stores one
// row from the source side; the GET handler tags each result with its
// direction, so the UI just looks the verb up here.
const VERBS: Record<TicketLinkType, Record<TicketLinkDirection, string>> = {
  blocks:     { outgoing: "blocks",      incoming: "is blocked by" },
  relates_to: { outgoing: "relates to",  incoming: "relates to" },
  duplicates: { outgoing: "duplicates",  incoming: "is duplicated by" },
};
function verb(l: TicketLink): string {
  return VERBS[l.type][l.direction];
}

// ─── add-link form (inline; not a dialog — fast to use repeatedly) ──────────
const formOpen = ref(false);
const formType = ref<TicketLinkType>("blocks");
const formTarget = ref("");

const TYPES: TicketLinkType[] = ["blocks", "relates_to", "duplicates"];
function typeLabel(t: TicketLinkType): string {
  // Forward verb only — the picker is always from the new link's source POV.
  return VERBS[t].outgoing;
}

const canSubmit = computed(
  () => formTarget.value.trim().length > 0 && !props.addingLink,
);

function submit() {
  if (!canSubmit.value) return;
  emit("add-link", { type: formType.value, target: formTarget.value.trim() });
  formTarget.value = "";
}

function reset() {
  formOpen.value = false;
  formTarget.value = "";
  formType.value = "blocks";
}
</script>

<template>
  <section class="space-y-2">
    <h3 class="text-xs uppercase tracking-wider text-muted-foreground">Linked work</h3>

    <!-- Parent breadcrumb-style row -->
    <div v-if="parentLoading" class="flex items-center gap-2">
      <Skeleton class="h-7 w-48" />
    </div>
    <button
      v-else-if="parent"
      type="button"
      class="flex w-full items-center gap-2 rounded-md border bg-card px-2.5 py-1.5 text-left text-sm hover:bg-accent/40 transition-colors"
      @click="$emit('navigate', parent.key)"
    >
      <CornerUpLeft class="h-3.5 w-3.5 text-muted-foreground shrink-0" />
      <span class="text-xs text-muted-foreground">Parent</span>
      <TypeIcon :type="parent.type" />
      <span class="font-mono text-xs text-muted-foreground">{{ parent.key }}</span>
      <span class="flex-1 min-w-0 truncate font-medium">{{ parent.title }}</span>
      <StatusBadge :category="parent.status.category" :display-name="parent.status.display_name" size="sm" />
    </button>

    <!-- Children, only shown when this ticket is an epic -->
    <template v-if="isEpic">
      <div class="flex items-center gap-2 text-xs text-muted-foreground pt-1">
        <Layers class="h-3.5 w-3.5" />
        <span>Sub-tickets ({{ children.length }})</span>
      </div>

      <div v-if="childrenLoading" class="space-y-1.5">
        <Skeleton v-for="n in 3" :key="n" class="h-7 w-full" />
      </div>

      <ul v-else-if="children.length > 0" class="space-y-1">
        <li v-for="c in children" :key="c.id">
          <button
            type="button"
            class="flex w-full items-center gap-2 rounded-md border bg-card px-2.5 py-1.5 text-left text-sm hover:bg-accent/40 transition-colors"
            @click="$emit('navigate', c.key)"
          >
            <TypeIcon :type="c.type" />
            <span class="font-mono text-xs text-muted-foreground">{{ c.key }}</span>
            <span class="flex-1 min-w-0 truncate">{{ c.title }}</span>
            <StatusBadge :category="c.status.category" :display-name="c.status.display_name" size="sm" />
          </button>
        </li>
      </ul>

      <p v-else class="text-xs text-muted-foreground italic">
        No sub-tickets yet. Create a ticket and set this epic as its parent.
      </p>
    </template>

    <!-- Typed cross-ticket links: blocks / relates_to / duplicates -->
    <div class="flex items-center gap-2 text-xs text-muted-foreground pt-2">
      <Link2 class="h-3.5 w-3.5" />
      <span>Links ({{ links.length }})</span>
      <button
        v-if="!formOpen"
        type="button"
        class="inline-flex items-center gap-1 rounded-md border border-dashed px-1.5 h-5 text-[10px] text-muted-foreground hover:text-foreground hover:border-foreground/40 transition-colors"
        @click="formOpen = true"
      >
        <Plus class="h-2.5 w-2.5" /> Link
      </button>
    </div>

    <ul v-if="links.length > 0" class="space-y-1">
      <li v-for="l in links" :key="l.id" class="group">
        <div class="flex w-full items-center gap-2 rounded-md border bg-card px-2.5 py-1.5 text-sm">
          <span class="text-xs text-muted-foreground capitalize shrink-0">{{ verb(l) }}</span>
          <button
            type="button"
            class="flex flex-1 min-w-0 items-center gap-2 text-left hover:text-foreground transition-colors"
            @click="$emit('navigate', l.other_ticket.key)"
          >
            <span class="font-mono text-xs text-muted-foreground">{{ l.other_ticket.key }}</span>
            <span class="flex-1 min-w-0 truncate">{{ l.other_ticket.title }}</span>
          </button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            class="opacity-0 group-hover:opacity-100 -my-1 h-6 w-6 p-0 text-muted-foreground hover:text-destructive"
            :disabled="removingLinkId === l.id"
            :title="`Remove this ${verb(l)} link`"
            @click="$emit('remove-link', l.id)"
          >
            <Loader2 v-if="removingLinkId === l.id" class="h-3 w-3 animate-spin" />
            <X v-else class="h-3 w-3" />
          </Button>
        </div>
      </li>
    </ul>
    <p v-else-if="!formOpen" class="text-xs text-muted-foreground italic">
      No links yet. Use "Link" to connect this ticket to another (blocks / relates to / duplicates).
    </p>

    <!-- Inline add form -->
    <form
      v-if="formOpen"
      class="grid grid-cols-[auto_1fr_auto_auto] gap-2 items-center"
      @submit.prevent="submit"
    >
      <select
        v-model="formType"
        class="rounded-md border bg-background px-2 py-1.5 text-xs"
      >
        <option v-for="t in TYPES" :key="t" :value="t">{{ typeLabel(t) }}</option>
      </select>
      <Input
        v-model="formTarget"
        placeholder="SWY-42 or uuid"
        class="text-xs font-mono"
        autofocus
      />
      <Button
        type="submit"
        size="sm"
        :disabled="!canSubmit"
        class="h-8"
      >
        <Loader2 v-if="addingLink" class="h-3 w-3 mr-1 animate-spin" />
        Link
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        class="h-8 px-2 text-muted-foreground"
        @click="reset"
      >
        Cancel
      </Button>
    </form>
  </section>
</template>
