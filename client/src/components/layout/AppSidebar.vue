<script setup lang="ts">
import { RouterLink, useRoute } from "vue-router";
import { computed } from "vue";
import { storeToRefs } from "pinia";
import {
  Inbox, LayoutDashboard, KanbanSquare, FolderKanban, Settings, Zap, Activity,
  HeartPulse, ChevronLeft, ChevronRight,
} from "lucide-vue-next";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Tooltip, TooltipContent, TooltipProvider, TooltipTrigger,
} from "@/components/ui/tooltip";
import SwitchyardLogo from "@/components/SwitchyardLogo.vue";
import { APP_VERSION_DISPLAY } from "@/lib/version";
import { useUiStore } from "@/stores/ui";

type NavItem = { to: string; label: string; icon: any; group: "main" | "admin" };

const items: NavItem[] = [
  { to: "/", label: "Dashboard", icon: LayoutDashboard, group: "main" },
  { to: "/tickets", label: "Tickets", icon: Inbox, group: "main" },
  { to: "/boards", label: "Boards", icon: KanbanSquare, group: "main" },
  { to: "/projects", label: "Projects", icon: FolderKanban, group: "main" },
  { to: "/insights/llm", label: "LLM Insights", icon: Activity, group: "main" },
  { to: "/automations", label: "Automations", icon: Zap, group: "main" },
  { to: "/settings", label: "Settings", icon: Settings, group: "admin" },
  { to: "/health", label: "Health", icon: HeartPulse, group: "admin" },
];

const route = useRoute();
const main = computed(() => items.filter((i) => i.group === "main"));
const admin = computed(() => items.filter((i) => i.group === "admin"));

const ui = useUiStore();
const { sidebarCollapsed: collapsed } = storeToRefs(ui);

// Active state needs to be the *most-specific* match, so when the user is on
// `/automations/webhooks/:id/deliveries`, only "Automations" highlights and
// "Settings" doesn't (despite both having a `/` prefix overlap with nothing).
// Find the longest matching `to`; everyone else is inactive.
const activeKey = computed(() => {
  let best: string | null = null;
  for (const item of items) {
    if (item.to === "/" ? route.path === "/" : route.path === item.to || route.path.startsWith(item.to + "/")) {
      if (!best || item.to.length > best.length) best = item.to;
    }
  }
  return best;
});

function isActive(to: string) {
  return activeKey.value === to;
}

// Per-item classes. Collapsed → icon centered, no inline label; expanded →
// icon + label with a gap. Active highlight spans the whole item either way.
function itemClass(to: string) {
  return [
    "flex items-center rounded-md py-1.5 text-muted-foreground hover:bg-accent hover:text-foreground transition-colors",
    collapsed.value ? "justify-center px-0" : "gap-2 px-3",
    isActive(to) && "bg-accent text-foreground",
  ];
}
</script>

<template>
  <aside
    class="hidden md:flex md:flex-col border-r bg-sidebar transition-[width] duration-200 ease-in-out"
    :class="collapsed ? 'md:w-16' : 'md:w-60'"
  >
    <!-- Logo header — structurally separate from the nav, so collapsing the
         menu below leaves the logo in place. Collapsed → cube mark only,
         centered in the rail; expanded → full mark + wordmark.
         TODO: replace wordmark with Commissioner (fonts.google.com/specimen/Commissioner)
         once the logo SVG is cleaned up as a proper mark-only file -->
    <div class="flex h-16 items-center border-b px-3 overflow-hidden">
      <RouterLink to="/" class="flex items-center" aria-label="Switchyard home">
        <SwitchyardLogo :collapsed="collapsed" />
      </RouterLink>
    </div>

    <ScrollArea class="flex-1">
      <TooltipProvider :delay-duration="200">
        <nav class="flex flex-col gap-1 p-3 text-sm">
          <Tooltip v-for="item in main" :key="item.to">
            <TooltipTrigger as-child>
              <RouterLink :to="item.to" :class="itemClass(item.to)" :aria-label="item.label">
                <component :is="item.icon" class="h-4 w-4 shrink-0" />
                <span v-if="!collapsed" class="truncate">{{ item.label }}</span>
              </RouterLink>
            </TooltipTrigger>
            <TooltipContent v-if="collapsed" side="right">{{ item.label }}</TooltipContent>
          </Tooltip>

          <Separator class="my-3" />
          <!-- Section header collapses to a single-letter glyph in the rail. -->
          <div
            class="text-xs font-medium uppercase tracking-wider text-muted-foreground"
            :class="collapsed ? 'text-center px-0' : 'px-3'"
          >
            {{ collapsed ? "A" : "Admin" }}
          </div>

          <Tooltip v-for="item in admin" :key="item.to">
            <TooltipTrigger as-child>
              <RouterLink :to="item.to" :class="itemClass(item.to)" :aria-label="item.label">
                <component :is="item.icon" class="h-4 w-4 shrink-0" />
                <span v-if="!collapsed" class="truncate">{{ item.label }}</span>
              </RouterLink>
            </TooltipTrigger>
            <TooltipContent v-if="collapsed" side="right">{{ item.label }}</TooltipContent>
          </Tooltip>
        </nav>
      </TooltipProvider>
    </ScrollArea>

    <!-- Footer: version chip + collapse toggle share one row so the toggle
         keeps a constant vertical position across collapse/expand (the version
         just hides in the rail — the string can't fit). Chevron points the way
         it affords: left to collapse, right to expand. -->
    <div class="flex items-center gap-2 border-t p-2">
      <span
        v-if="!collapsed"
        class="min-w-0 flex-1 truncate px-2 text-[10px] text-muted-foreground/70 font-mono"
      >
        {{ APP_VERSION_DISPLAY }}
      </span>
      <button
        type="button"
        class="flex items-center rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
        :class="collapsed && 'mx-auto'"
        :aria-label="collapsed ? 'Expand sidebar' : 'Collapse sidebar'"
        :title="collapsed ? 'Expand sidebar' : 'Collapse sidebar'"
        @click="ui.toggleSidebar()"
      >
        <component :is="collapsed ? ChevronRight : ChevronLeft" class="h-4 w-4" />
      </button>
    </div>
  </aside>
</template>
