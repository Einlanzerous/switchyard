<script setup lang="ts">
import { RouterLink, RouterView, useRoute } from "vue-router";
import { Webhook, Workflow, Send } from "lucide-vue-next";
import { cn } from "@/lib/utils";

// Automations is the integration surface: webhooks, rules, and the named
// targets that both can reference. Layout mirrors Settings — left sidebar
// of sub-areas, main panel for the active page.
type NavItem = { to: string; label: string; icon: any; badge?: string };

const items: NavItem[] = [
  { to: "/automations/webhooks", label: "Webhooks", icon: Webhook },
  { to: "/automations/rules", label: "Rules", icon: Workflow },
  { to: "/automations/targets", label: "Targets", icon: Send },
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
          :to="item.to"
          :class="cn(
            'flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground transition-colors',
            'hover:bg-accent hover:text-foreground',
            isActive(item.to) && 'bg-accent text-foreground',
          )"
        >
          <component :is="item.icon" class="h-3.5 w-3.5" />
          <span class="flex-1">{{ item.label }}</span>
        </RouterLink>
      </nav>
    </aside>

    <main>
      <RouterView />
    </main>
  </div>
</template>
