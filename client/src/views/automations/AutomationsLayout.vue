<script setup lang="ts">
import { RouterLink, RouterView, useRoute } from "vue-router";
import { Webhook, Workflow } from "lucide-vue-next";
import { cn } from "@/lib/utils";

// Automations is the integration surface: webhooks today, native automation
// rules in Phase 4. The layout mirrors Settings — left sidebar of sub-areas,
// main panel for the active page — so users learn one chrome shape.
type NavItem = { to: string; label: string; icon: any; badge?: string };

const items: NavItem[] = [
  { to: "/automations/webhooks", label: "Webhooks", icon: Webhook },
  { to: "/automations/rules", label: "Rules", icon: Workflow, badge: "Phase 4" },
];

const route = useRoute();
function isActive(to: string) {
  return route.path === to || route.path.startsWith(to + "/");
}
</script>

<template>
  <div class="container max-w-6xl py-6 grid grid-cols-1 md:grid-cols-[14rem_1fr] gap-6">
    <aside class="md:sticky md:top-6 self-start">
      <h1 class="text-lg font-semibold tracking-tight mb-3 px-2">Automations</h1>
      <p class="text-xs text-muted-foreground mb-3 px-2">
        How switchyard talks to the rest of your pipeline.
      </p>
      <nav class="space-y-1">
        <RouterLink
          v-for="item in items"
          :key="item.to"
          :to="item.badge ? '#' : item.to"
          :class="cn(
            'flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground transition-colors',
            item.badge
              ? 'cursor-not-allowed opacity-50'
              : 'hover:bg-accent hover:text-foreground',
            !item.badge && isActive(item.to) && 'bg-accent text-foreground',
          )"
          @click="(e: MouseEvent) => item.badge && e.preventDefault()"
        >
          <component :is="item.icon" class="h-3.5 w-3.5" />
          <span class="flex-1">{{ item.label }}</span>
          <span
            v-if="item.badge"
            class="text-[10px] rounded border px-1 py-0 font-mono"
          >{{ item.badge }}</span>
        </RouterLink>
      </nav>
    </aside>

    <main>
      <RouterView />
    </main>
  </div>
</template>
