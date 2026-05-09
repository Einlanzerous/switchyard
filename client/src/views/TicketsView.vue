<script setup lang="ts">
import { computed, watch, useTemplateRef, onMounted, onBeforeUnmount } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useVirtualizer } from "@tanstack/vue-virtual";
import { Inbox, Loader2, AlertCircle, KanbanSquare, Plus } from "lucide-vue-next";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import FilterBar from "@/components/tickets/FilterBar.vue";
import TicketRow from "@/components/tickets/TicketRow.vue";
import { useTicketFilters } from "@/composables/useTicketFilters";
import { useTicketsList } from "@/composables/useTicketsList";
import { useUiStore } from "@/stores/ui";

const ui = useUiStore();

const { filters, isAnySet, clear } = useTicketFilters();

// Board view is only useful when scoped to a single project — otherwise the
// kanban columns would mix tickets across projects with possibly conflicting
// statuses. Cross-project boards are a separate surface (milestone 2.5).
const singleProjectKey = computed(() =>
  filters.value.project.length === 1 ? filters.value.project[0]! : null
);
const { items, isLoading, isFetchingNextPage, hasNextPage, fetchNextPage, error } =
  useTicketsList(filters);

const route = useRoute();
const router = useRouter();

const focusedKey = computed(() => {
  const f = route.query.focus;
  return typeof f === "string" && f.length > 0 ? f : null;
});

function openTicket(key: string) {
  router.replace({ query: { ...route.query, focus: key } });
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
</script>

<template>
  <div class="flex flex-col h-full">
    <FilterBar>
      <template #actions>
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
            @open="openTicket"
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
