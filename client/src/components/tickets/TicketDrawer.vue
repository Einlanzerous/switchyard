<script setup lang="ts">
import { computed, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useQuery } from "@tanstack/vue-query";
import { ExternalLink, MoreHorizontal, FolderInput } from "lucide-vue-next";
import {
  Sheet, SheetContent, SheetTitle, SheetDescription,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import TicketBody from "./TicketBody.vue";
import TicketTitleEditor from "./TicketTitleEditor.vue";
import TypeIcon from "./TypeIcon.vue";
import MoveTicketDialog from "./MoveTicketDialog.vue";
import { api } from "@/lib/api";
import { queryKeys } from "@/lib/queryKeys";
import { useProjectPermissions } from "@/composables/useProjectPermissions";

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

// The drawer header renders its own title, OUTSIDE TicketBody's
// provideTicketCanWrite provider, so resolve write capability here from the
// focused ticket's project for the inline title editor.
const { canWrite } = useProjectPermissions(() => titleTicket.value?.project.key ?? null);

const moveDialogOpen = ref(false);
function openMoveDialog() { moveDialogOpen.value = true; }
</script>

<template>
  <Sheet :open="isOpen" @update:open="isOpen = $event">
    <!-- v4: 860px drawer (deliberately wider than the old 672px — the
         content is dense). -->
    <SheetContent side="right" class="w-full sm:max-w-[860px] flex flex-col gap-0 p-0">
      <!-- The Sheet component already renders a close X in the top-right.
           We add a header row with the ticket key + title and the
           "open in full page" action; the close X stays where Sheet puts it. -->
      <div class="flex items-center gap-2 border-b pl-5 pr-12 py-3">
        <template v-if="titleTicket">
          <TypeIcon :type="titleTicket.type" class="shrink-0" />
          <span class="font-mono text-[13px] font-medium text-ink-3 shrink-0">
            {{ titleTicket.key }}
          </span>
          <SheetTitle class="flex-1 min-w-0">
            <TicketTitleEditor
              :ticket-key="titleTicket.key"
              :ticket-id="titleTicket.id"
              :title="titleTicket.title"
              :can-write="canWrite"
              text-class="text-[14.5px] font-bold tracking-tight truncate block"
            />
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
          aria-label="Open ticket in full page"
          @click="openFullPage"
        >
          <ExternalLink class="h-3.5 w-3.5" />
        </Button>
        <DropdownMenu v-if="titleTicket">
          <DropdownMenuTrigger as-child>
            <Button variant="ghost" size="icon" class="h-7 w-7 shrink-0" aria-label="More actions">
              <MoreHorizontal class="h-3.5 w-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem class="cursor-pointer" @click="openMoveDialog">
              <FolderInput class="h-3.5 w-3.5 mr-2" /> Move to project…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
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

  <MoveTicketDialog
    v-if="titleTicket"
    v-model:open="moveDialogOpen"
    :ticket="titleTicket"
    @moved="(newKey) => focusKey(newKey)"
  />
</template>
