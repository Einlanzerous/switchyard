<script setup lang="ts">
import { computed, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useQuery } from "@tanstack/vue-query";
import { ExternalLink } from "lucide-vue-next";
import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import StatusBadge from "./StatusBadge.vue";
import PriorityBadge from "./PriorityBadge.vue";
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

const ticketQuery = useQuery({
  queryKey: computed(() => queryKeys.ticket(focusedKey.value ?? "__none__")),
  enabled: computed(() => focusedKey.value !== null),
  queryFn: async () => {
    const key = focusedKey.value;
    if (!key) throw new Error("no focus");
    const { data, error } = await api.GET("/v1/tickets/{idOrKey}", {
      params: { path: { idOrKey: key } },
    });
    if (error) throw error;
    return data;
  },
});

const ticket = computed(() => ticketQuery.data.value);
const loading = computed(() => ticketQuery.isLoading.value);

// Close drawer if route changes away (Escape or back button) — Sheet handles
// its own onOpenChange, but we also clear the focus on real navigation.
watch(focusedKey, (v) => { if (!v && isOpen.value) {/* nothing */} });
</script>

<template>
  <Sheet :open="isOpen" @update:open="isOpen = $event">
    <SheetContent side="right" class="w-full sm:max-w-xl flex flex-col p-0">
      <SheetHeader class="px-5 py-4 border-b">
        <div class="flex items-start gap-2">
          <div class="flex-1 min-w-0 space-y-1">
            <div v-if="loading" class="space-y-2">
              <Skeleton class="h-4 w-24" />
              <Skeleton class="h-6 w-3/4" />
            </div>
            <template v-else-if="ticket">
              <div class="flex items-center gap-2 text-xs text-muted-foreground">
                <span class="font-mono">{{ ticket.key }}</span>
                <span>·</span>
                <span>{{ ticket.project.name }}</span>
              </div>
              <SheetTitle class="text-xl flex items-start gap-2">
                <TypeIcon :type="ticket.type" class="mt-1" />
                <span>{{ ticket.title }}</span>
              </SheetTitle>
            </template>
          </div>

          <Button
            v-if="ticket"
            variant="ghost"
            size="icon"
            :title="`Open ${ticket.key} in full page`"
            @click="router.push(`/tickets/${ticket.key}`)"
          >
            <ExternalLink class="h-4 w-4" />
          </Button>
        </div>
      </SheetHeader>

      <div class="flex-1 overflow-auto p-5 space-y-5">
        <div v-if="loading" class="space-y-3">
          <Skeleton class="h-4 w-full" />
          <Skeleton class="h-4 w-2/3" />
          <Skeleton class="h-4 w-3/4" />
        </div>

        <template v-else-if="ticket">
          <SheetDescription class="sr-only">
            Ticket details for {{ ticket.key }}
          </SheetDescription>

          <!-- Meta strip -->
          <div class="flex flex-wrap items-center gap-3 text-sm">
            <span class="inline-flex items-center gap-1.5 capitalize text-foreground/90">
              <TypeIcon :type="ticket.type" />
              {{ ticket.type }}
            </span>
            <StatusBadge :category="ticket.status.category" :display-name="ticket.status.display_name" />
            <PriorityBadge :priority="ticket.priority" show-label />
            <span v-if="ticket.assignee" class="text-muted-foreground">
              Assigned to <span class="text-foreground">{{ ticket.assignee.name }}</span>
            </span>
            <span v-else class="text-muted-foreground">Unassigned</span>
          </div>

          <!-- Description (raw for now; markdown render lands in 2.3) -->
          <section>
            <h3 class="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">Description</h3>
            <div
              v-if="ticket.description"
              class="text-sm whitespace-pre-wrap text-foreground/90"
            >{{ ticket.description }}</div>
            <p v-else class="text-sm text-muted-foreground italic">No description.</p>
          </section>

          <!-- Comments -->
          <section v-if="ticket.comments.length > 0">
            <h3 class="text-xs uppercase tracking-wider text-muted-foreground mb-2">
              Comments ({{ ticket.comments.length }})
            </h3>
            <ul class="space-y-3">
              <li v-for="c in ticket.comments" :key="c.id" class="text-sm border-l-2 border-border pl-3">
                <div class="text-xs text-muted-foreground mb-0.5">
                  {{ c.author.name }} · {{ new Date(c.created_at).toLocaleString() }}
                </div>
                <div class="whitespace-pre-wrap">{{ c.body }}</div>
              </li>
            </ul>
          </section>

          <!-- Attachments -->
          <section v-if="ticket.all_attachments.length > 0">
            <h3 class="text-xs uppercase tracking-wider text-muted-foreground mb-2">
              Files ({{ ticket.all_attachments.length }})
            </h3>
            <ul class="space-y-1.5">
              <li v-for="a in ticket.all_attachments" :key="a.id" class="text-sm">
                <a :href="a.url" target="_blank" class="text-primary hover:underline">
                  {{ a.original_name ?? a.id }}
                </a>
                <span class="text-xs text-muted-foreground ml-2">
                  {{ a.kind }} · {{ Math.round(a.size_bytes / 1024) }}kb
                </span>
              </li>
            </ul>
          </section>

          <p class="text-xs text-muted-foreground italic pt-4 border-t">
            Markdown rendering, comment composer, attachment upload, and the
            transition button land in milestone 2.3.
          </p>
        </template>
      </div>
    </SheetContent>
  </Sheet>
</template>
