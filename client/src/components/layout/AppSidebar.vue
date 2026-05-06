<script setup lang="ts">
import { RouterLink, useRoute } from "vue-router";
import { computed } from "vue";
import { Inbox, LayoutDashboard, KanbanSquare, FolderKanban, Settings, Webhook } from "lucide-vue-next";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";

type NavItem = { to: string; label: string; icon: any; group: "main" | "settings" };

const items: NavItem[] = [
  { to: "/", label: "Dashboard", icon: LayoutDashboard, group: "main" },
  { to: "/tickets", label: "Tickets", icon: Inbox, group: "main" },
  { to: "/boards", label: "Boards", icon: KanbanSquare, group: "main" },
  { to: "/projects", label: "Projects", icon: FolderKanban, group: "main" },
  { to: "/settings/webhooks", label: "Webhooks", icon: Webhook, group: "settings" },
  { to: "/settings", label: "Settings", icon: Settings, group: "settings" },
];

const route = useRoute();
const main = computed(() => items.filter((i) => i.group === "main"));
const settings = computed(() => items.filter((i) => i.group === "settings"));

function isActive(to: string) {
  if (to === "/") return route.path === "/";
  return route.path.startsWith(to);
}
</script>

<template>
  <aside class="hidden md:flex md:w-60 md:flex-col border-r bg-muted/30">
    <div class="flex h-14 items-center px-4 border-b">
      <RouterLink to="/" class="flex items-center gap-2 font-semibold tracking-tight">
        <span class="inline-block h-6 w-6 rounded bg-primary" />
        switchyard
      </RouterLink>
    </div>

    <ScrollArea class="flex-1">
      <nav class="flex flex-col gap-1 p-3 text-sm">
        <RouterLink
          v-for="item in main"
          :key="item.to"
          :to="item.to"
          class="flex items-center gap-2 rounded-md px-3 py-1.5 text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
          :class="isActive(item.to) && 'bg-accent text-foreground'"
        >
          <component :is="item.icon" class="h-4 w-4" />
          {{ item.label }}
        </RouterLink>

        <Separator class="my-3" />
        <div class="px-3 text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Admin
        </div>

        <RouterLink
          v-for="item in settings"
          :key="item.to"
          :to="item.to"
          class="flex items-center gap-2 rounded-md px-3 py-1.5 text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
          :class="isActive(item.to) && 'bg-accent text-foreground'"
        >
          <component :is="item.icon" class="h-4 w-4" />
          {{ item.label }}
        </RouterLink>
      </nav>
    </ScrollArea>
  </aside>
</template>
