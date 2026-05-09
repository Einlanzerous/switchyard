<script setup lang="ts">
import { computed } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useQuery } from "@tanstack/vue-query";
import { ExternalLink } from "lucide-vue-next";
import {
  Sheet, SheetContent, SheetTitle, SheetDescription,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import TicketBody from "./TicketBody.vue";
import TypeIcon from "./TypeIcon.vue";
import { api } from "@/lib/api";
import { queryKeys } from "@/lib/queryKeys";

const route = useRoute();
const router = useRouter();

// `?focus=KEY-N` drives whether the drawer is open. Closing it clears the
// query param without disturbing other filter state.
const focusedKey = computed(() => {
  const f = route.query.focus;
  return typeof f === "string" && f.length > 0 ? f : null;
});

const isOpen = computed({
  get: () => focusedKey.value !== null,
  set: (v: boolean) => { if (!v) closeDrawer(); },
});

function closeDrawer() {
  const { focus, ...rest } = route.query;
  void focus;
  router.replace({ query: rest });
}

function openFullPage() {
  const key = focusedKey.value;
  if (!key) return;
  router.push(`/tickets/${key}`);
}

// Linked-work navigation inside the drawer just swaps the focus param so the
// drawer keeps the user in context (no full page push, list stays behind).
function focusKey(key: string) {
  router.replace({ query: { ...route.query, focus: key } });
}

// Read the cache for the title — TicketBody fires its own query for the same
// key, so this is a free read once data is loaded. We use it to populate the
// SheetTitle so it reads "FLOW-2 Big Work" instead of a generic label.
const headTicket = useQuery({
  queryKey: computed(() => queryKeys.ticket(focusedKey.value ?? "__none__")),
  enabled: computed(() => focusedKey.value !== null),
  queryFn: async () => {
    const v = focusedKey.value;
    if (!v) throw new Error("no focus");
    const { data, error } = await api.GET("/v1/tickets/{idOrKey}", {
      params: { path: { idOrKey: v } },
    });
    if (error) throw error;
    return data;
  },
});
const titleTicket = computed(() => headTicket.data.value);
</script>

<template>
  <Sheet :open="isOpen" @update:open="isOpen = $event">
    <SheetContent side="right" class="w-full sm:max-w-2xl flex flex-col gap-0 p-0">
      <!-- The Sheet component already renders a close X in the top-right.
           We add a header row with the ticket key + title and the
           "open in full page" action; the close X stays where Sheet puts it. -->
      <div class="flex items-center gap-2 border-b pl-5 pr-12 py-3">
        <template v-if="titleTicket">
          <TypeIcon :type="titleTicket.type" class="shrink-0" />
          <span class="font-mono text-base font-medium text-muted-foreground shrink-0">
            {{ titleTicket.key }}
          </span>
          <SheetTitle class="text-base font-semibold tracking-tight truncate flex-1">
            {{ titleTicket.title }}
          </SheetTitle>
        </template>
        <SheetTitle v-else class="font-mono text-base text-muted-foreground flex-1">
          {{ focusedKey ?? "Loading…" }}
        </SheetTitle>

        <Button
          v-if="focusedKey"
          variant="ghost"
          size="icon"
          class="h-7 w-7 shrink-0"
          title="Open in full page"
          @click="openFullPage"
        >
          <ExternalLink class="h-3.5 w-3.5" />
        </Button>
      </div>
      <SheetDescription class="sr-only">
        Detail panel for ticket {{ focusedKey ?? "" }}
      </SheetDescription>

      <div class="flex-1 overflow-auto px-5 py-5">
        <TicketBody
          v-if="focusedKey"
          :id-or-key="focusedKey"
          :hide-title="true"
          :on-link-navigate="focusKey"
        />
      </div>
    </SheetContent>
  </Sheet>
</template>
