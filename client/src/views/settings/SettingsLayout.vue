<script setup lang="ts">
import { computed } from "vue";
import { RouterLink, RouterView, useRoute } from "vue-router";
import {
  User as UserIcon, Key, Tag, FolderKanban, Users,
} from "lucide-vue-next";
import { cn } from "@/lib/utils";

type NavItem = { to: string; label: string; icon: any };
type NavGroup = { label: string; items: NavItem[] };

const groups: NavGroup[] = [
  {
    label: "Personal",
    items: [
      { to: "/settings/profile", label: "Profile", icon: UserIcon },
      { to: "/settings/tokens", label: "API tokens", icon: Key },
    ],
  },
  {
    label: "Workspace",
    items: [
      { to: "/settings/labels", label: "Labels", icon: Tag },
      { to: "/settings/projects", label: "Projects", icon: FolderKanban },
    ],
  },
  {
    label: "Admin",
    items: [
      { to: "/settings/users", label: "Users", icon: Users },
    ],
  },
];

const route = useRoute();
function isActive(to: string) {
  // Exact match for the section root, prefix-match for nested pages
  // (e.g. /settings/projects/SAMPLE keeps "Projects" highlighted).
  return route.path === to || route.path.startsWith(to + "/");
}

const flatTitle = computed(() => {
  for (const g of groups) {
    for (const item of g.items) {
      if (isActive(item.to)) return item.label;
    }
  }
  return "Settings";
});
</script>

<template>
  <div class="container max-w-6xl py-6 grid grid-cols-1 md:grid-cols-[14rem_1fr] gap-6">
    <aside class="md:sticky md:top-6 self-start">
      <h1 class="text-lg font-semibold tracking-tight mb-3 px-2">Settings</h1>
      <nav class="space-y-4">
        <div v-for="g in groups" :key="g.label" class="space-y-1">
          <div class="px-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            {{ g.label }}
          </div>
          <RouterLink
            v-for="item in g.items"
            :key="item.to"
            :to="item.to"
            :class="cn(
              'flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground hover:bg-accent hover:text-foreground transition-colors',
              isActive(item.to) && 'bg-accent text-foreground',
            )"
          >
            <component :is="item.icon" class="h-3.5 w-3.5" />
            {{ item.label }}
          </RouterLink>
        </div>
      </nav>
    </aside>

    <main>
      <h2 class="md:hidden text-base font-semibold mb-4">{{ flatTitle }}</h2>
      <RouterView />
    </main>
  </div>
</template>
