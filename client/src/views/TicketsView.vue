<script setup lang="ts">
import { computed, ref, watch, useTemplateRef, onMounted, onBeforeUnmount } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useVirtualizer } from "@tanstack/vue-virtual";
import { Inbox, Loader2, AlertCircle, KanbanSquare, Plus } from "lucide-vue-next";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import FilterBar from "@/components/tickets/FilterBar.vue";
import TicketRow from "@/components/tickets/TicketRow.vue";
import SavedViewsMenu from "@/components/tickets/SavedViewsMenu.vue";
import SaveViewDialog from "@/components/tickets/SaveViewDialog.vue";
import BulkActionBar from "@/components/tickets/BulkActionBar.vue";
import { useTicketFilters } from "@/composables/useTicketFilters";
import { useTicketsList } from "@/composables/useTicketsList";
import { useTicketSort } from "@/composables/useTicketSort";
import SortMenu from "@/components/tickets/SortMenu.vue";
import { useUiStore } from "@/stores/ui";

const ui = useUiStore();
const showSaveView = ref(false);

const { filters, isAnySet, clear } = useTicketFilters();
const { sort, direction, setBy, setOrder } = useTicketSort();

// Server-side sort knobs. The list defaults to updated_at DESC; users opt
// into due-date sort to answer "what's next due across all my projects".
const SORT_BY_OPTIONS = [
  { value: "updated_at" as const, label: "Recently updated" },
  { value: "due_date" as const, label: "Due date" },
  { value: "created_at" as const, label: "Recently created" },
  { value: "priority" as const, label: "Priority" },
];
const SORT_ORDER_OPTIONS = [
  { value: "asc" as const, label: "Ascending" },
  { value: "desc" as const, label: "Descending" },
];

// ─── bulk selection ─────────────────────────────────────────────────────────
//
// Selection lives on this view (no Pinia) because it's transient — moving
// off the page or filtering should clear it. We track ticket keys (not ids)
// so range-select on shift-click is positional within the visible list.

const selected = ref<Set<string>>(new Set());
const selectionAnchor = ref<string | null>(null);

function clearSelection() {
  selected.value = new Set();
  selectionAnchor.value = null;
}

// Filter changes invalidate range-select intent (the visible order may
// reshuffle); easiest is to drop the anchor. We DON'T drop the selection
// outright — a user filtering and bulk-acting on the filtered set is
// reasonable, even if some selected rows are now offscreen.
watch(() => filters.value, () => {
  selectionAnchor.value = null;
});

// Board view is only useful when scoped to a single project — otherwise the
// kanban columns would mix tickets across projects with possibly conflicting
// statuses. Cross-project boards are a separate surface (milestone 2.5).
const singleProjectKey = computed(() =>
  filters.value.project.length === 1 ? filters.value.project[0]! : null
);
const { items, isLoading, isFetchingNextPage, hasNextPage, fetchNextPage, error } =
  useTicketsList(filters, sort);

const route = useRoute();
const router = useRouter();

const focusedKey = computed(() => {
  const f = route.query.focus;
  return typeof f === "string" && f.length > 0 ? f : null;
});

function openTicket(key: string) {
  router.replace({ query: { ...route.query, focus: key } });
}

function toggleSelect(key: string, withRange: boolean) {
  if (withRange && selectionAnchor.value) {
    // Range-select: from anchor to clicked, both inclusive, in current
    // visible order. Each ticket key in that span gets ADDED to the
    // selection (range-select is additive, like Linear / Gmail).
    const list = items.value;
    const a = list.findIndex((t) => t.key === selectionAnchor.value);
    const b = list.findIndex((t) => t.key === key);
    if (a >= 0 && b >= 0) {
      const [lo, hi] = a < b ? [a, b] : [b, a];
      const next = new Set(selected.value);
      for (let i = lo; i <= hi; i++) next.add(list[i]!.key);
      selected.value = next;
      return;
    }
  }
  // Single-toggle. Update anchor to this row so a later shift-click ranges
  // from here.
  const next = new Set(selected.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  selected.value = next;
  selectionAnchor.value = key;
}

const allOnPageSelected = computed(() =>
  items.value.length > 0 && items.value.every((t) => selected.value.has(t.key))
);
const someSelected = computed(() => selected.value.size > 0);

// The bulk action bar needs full TicketSummary objects (it operates on
// labels / project / id), not just keys. Resolve from the loaded list.
const selectedTickets = computed(() => items.value.filter((t) => selected.value.has(t.key)));

function toggleSelectAll() {
  if (allOnPageSelected.value) {
    clearSelection();
  } else {
    const next = new Set<string>();
    for (const t of items.value) next.add(t.key);
    selected.value = next;
    selectionAnchor.value = items.value[0]?.key ?? null;
  }
}

// ─── virtualization ─────────────────────────────────────────────────────────
const scrollEl = useTemplateRef<HTMLElement>("scrollEl");

const rowVirtualizer = useVirtualizer(
  computed(() => ({
    count: items.value.length,
    getScrollElement: () => scrollEl.value,
    estimateSize: () => 48,
    overscan: 12,
  }))
);

const virtualItems = computed(() => rowVirtualizer.value.getVirtualItems());
const totalSize = computed(() => rowVirtualizer.value.getTotalSize());

// Trigger fetchNextPage when we're within 8 rows of the end. Done in a watcher
// so it fires whenever the virtualized window shifts (scrolling) OR the data
// length changes (page load resolves).
watch(virtualItems, (vis) => {
  const last = vis[vis.length - 1];
  if (!last) return;
  if (last.index >= items.value.length - 8 && hasNextPage.value && !isFetchingNextPage.value) {
    fetchNextPage();
  }
});

// Resize observer keeps virtualizer accurate when the panel grows/shrinks.
let ro: ResizeObserver | null = null;
onMounted(() => {
  if (!scrollEl.value || typeof ResizeObserver === "undefined") return;
  ro = new ResizeObserver(() => rowVirtualizer.value.measure());
  ro.observe(scrollEl.value);
});
onBeforeUnmount(() => { ro?.disconnect(); ro = null; });

const errMessage = computed(() => {
  const e = error.value;
  if (!e) return null;
  return (e as { error?: { message?: string } }).error?.message ?? "Failed to load tickets";
});

// ─── keyboard nav (3.4 C) ───────────────────────────────────────────────────
//
// Per-view bindings layered on top of the global ones. The global handler
// in AppShell skips when the user is typing in an input; we re-do that
// check here too because window-level keydown can fire while the FilterBar
// search input has focus.
//
// Bindings (active on the tickets list):
//   ArrowDown / j   — next row
//   ArrowUp   / k   — previous row
//   Enter           — open the focused row in the drawer
//   x               — toggle bulk selection on the focused row
//   Shift+x         — extend bulk selection from the previous anchor
//   Esc             — clear focus + selection (keyboard-first dismiss)

const keyboardFocusIdx = ref<number>(-1);

function isTypingTarget(t: EventTarget | null): boolean {
  if (!t || !(t instanceof HTMLElement)) return false;
  if (t.isContentEditable) return true;
  const tag = t.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

function moveFocus(delta: number) {
  const len = items.value.length;
  if (len === 0) return;
  if (keyboardFocusIdx.value === -1) {
    keyboardFocusIdx.value = delta > 0 ? 0 : len - 1;
  } else {
    keyboardFocusIdx.value = Math.max(0, Math.min(len - 1, keyboardFocusIdx.value + delta));
  }
  // Bring the focused row into view; vue-virtual exposes scrollToIndex.
  rowVirtualizer.value.scrollToIndex(keyboardFocusIdx.value, { align: "auto" });
}

function onListKeydown(e: KeyboardEvent) {
  if (isTypingTarget(e.target)) return;
  // Stay out of the way when modifier keys are involved (Ctrl+K, etc.).
  if (e.ctrlKey || e.metaKey || e.altKey) return;

  switch (e.key) {
    case "ArrowDown":
    case "j":
      e.preventDefault();
      moveFocus(1);
      return;
    case "ArrowUp":
    case "k":
      e.preventDefault();
      moveFocus(-1);
      return;
    case "Enter": {
      const t = items.value[keyboardFocusIdx.value];
      if (t) {
        e.preventDefault();
        openTicket(t.key);
      }
      return;
    }
    case "x":
    case "X": {
      const t = items.value[keyboardFocusIdx.value];
      if (!t) return;
      e.preventDefault();
      toggleSelect(t.key, e.shiftKey);
      return;
    }
    case "Escape":
      // Drawer's own Esc handling is on the Sheet; we only handle this
      // when no drawer is open (focusedKey is null). Otherwise Escape
      // stays a drawer-close.
      if (!focusedKey.value && (someSelected.value || keyboardFocusIdx.value !== -1)) {
        e.preventDefault();
        keyboardFocusIdx.value = -1;
        clearSelection();
      }
      return;
  }
}

onMounted(() => window.addEventListener("keydown", onListKeydown));
onBeforeUnmount(() => window.removeEventListener("keydown", onListKeydown));

// Filter changes invalidate the focused index — rows reshuffle and the old
// position no longer points at the same ticket.
watch(() => filters.value, () => { keyboardFocusIdx.value = -1; });
</script>

<template>
  <div class="flex flex-col h-full">
    <FilterBar>
      <template #actions>
        <SortMenu
          :model-value="sort.sort_by"
          :options="SORT_BY_OPTIONS"
          label="Sort"
          @update:model-value="setBy"
        />
        <SortMenu
          :model-value="direction"
          :options="SORT_ORDER_OPTIONS"
          label="Order"
          @update:model-value="setOrder"
        />
        <SavedViewsMenu @save="showSaveView = true" />
        <Button
          v-if="singleProjectKey"
          variant="outline"
          size="sm"
          class="h-8"
          @click="router.push(`/projects/${singleProjectKey}/board`)"
        >
          <KanbanSquare class="h-3.5 w-3.5 mr-1.5" />
          Board view
        </Button>
        <Button size="sm" class="h-8" @click="ui.openCreateTicket(singleProjectKey)">
          <Plus class="h-3.5 w-3.5 mr-1.5" />
          New ticket
        </Button>
      </template>
    </FilterBar>

    <SaveViewDialog v-model:open="showSaveView" />

    <BulkActionBar :selected-tickets="selectedTickets" @clear="clearSelection" />

    <!-- Initial-load skeleton -->
    <div v-if="isLoading" class="flex-1 px-4 py-2 space-y-2">
      <Skeleton v-for="n in 12" :key="n" class="h-10 w-full" />
    </div>

    <!-- Error state -->
    <div v-else-if="errMessage" class="flex-1 flex flex-col items-center justify-center p-10 text-center">
      <AlertCircle class="h-8 w-8 text-destructive mb-2" />
      <p class="text-sm text-destructive">{{ errMessage }}</p>
    </div>

    <!-- Empty state -->
    <div v-else-if="items.length === 0" class="flex-1 flex flex-col items-center justify-center p-10 text-center">
      <Inbox class="h-10 w-10 text-muted-foreground/40 mb-3" />
      <h3 class="text-sm font-medium">No tickets match these filters.</h3>
      <p class="text-xs text-muted-foreground mt-1">Try widening the search or clearing filters.</p>
      <Button v-if="isAnySet" variant="outline" size="sm" class="mt-3" @click="clear">
        Clear filters
      </Button>
    </div>

    <!-- Virtualized list -->
    <div v-else ref="scrollEl" class="flex-1 overflow-auto relative">
      <div :style="{ height: `${totalSize}px`, width: '100%', position: 'relative' }">
        <div
          v-for="vi in virtualItems"
          :key="String(vi.key)"
          :style="{
            position: 'absolute',
            top: 0,
            left: 0,
            width: '100%',
            height: `${vi.size}px`,
            transform: `translateY(${vi.start}px)`,
          }"
        >
          <TicketRow
            :ticket="items[vi.index]!"
            :active="items[vi.index]?.key === focusedKey"
            :selected="selected.has(items[vi.index]!.key)"
            :focused="vi.index === keyboardFocusIdx"
            @open="openTicket"
            @toggle-select="toggleSelect"
          />
        </div>
      </div>

      <div v-if="isFetchingNextPage" class="flex items-center justify-center py-3 text-xs text-muted-foreground">
        <Loader2 class="h-3.5 w-3.5 animate-spin mr-2" /> Loading more…
      </div>
      <div v-else-if="!hasNextPage && items.length > 0" class="text-center py-3 text-[11px] text-muted-foreground/70">
        End of results · {{ items.length }} ticket{{ items.length === 1 ? "" : "s" }}
      </div>
    </div>

  </div>
</template>
