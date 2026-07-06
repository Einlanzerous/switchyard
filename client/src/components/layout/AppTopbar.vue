<script setup lang="ts">
import { Search, Inbox, LogOut, Settings as SettingsIcon } from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import NotificationsBell from "./NotificationsBell.vue";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import UserAvatar from "@/components/UserAvatar.vue";
import { useAuthStore } from "@/stores/auth";
import { useUiStore } from "@/stores/ui";
import { useRouter } from "vue-router";

const auth = useAuthStore();
const ui = useUiStore();
const router = useRouter();

function logout() {
  auth.logout();
  router.push("/login");
}
</script>

<template>
  <!--
    Three-column flex: left spacer · centered search · right-justified
    actions. Centering plus a slightly taller search bar (h-11 vs h-8 on
    page-level FilterBars) keeps the topbar from looking like a mirror
    image of the sub-page search inputs sitting directly underneath it.
  -->
  <header class="flex h-14 items-center gap-3 border-b dark:border-line-soft px-5">
    <div class="flex-1" aria-hidden="true" />

    <div class="w-full max-w-[560px]">
      <!-- v4 search pill: 34px on the card surface with a line border; the
           kbd hint rides the right edge. -->
      <button
        type="button"
        class="relative w-full h-[34px] rounded-[7px] border border-border bg-card hover:bg-accent text-left text-[13px] text-ink-3 px-3 transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-ring flex items-center gap-2.5"
        aria-label="Open command palette"
        @click="ui.openPalette()"
      >
        <Search class="h-[15px] w-[15px] shrink-0 opacity-60" />
        <span class="truncate">Search tickets, projects, boards…</span>
        <kbd class="kbd-chip ml-auto hidden sm:inline-flex select-none items-center shrink-0">
          Ctrl+K
        </kbd>
      </button>
    </div>

    <div class="flex-1 flex items-center justify-end gap-2">
      <NotificationsBell v-if="auth.isAuthenticated" />

      <DropdownMenu v-if="auth.isAuthenticated">
        <DropdownMenuTrigger as-child>
          <Button variant="ghost" size="icon" class="rounded-full" aria-label="User menu">
            <UserAvatar :user="auth.me" size="lg" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" class="w-48">
          <DropdownMenuLabel class="text-xs text-muted-foreground">
            {{ auth.me?.name }} · {{ auth.me?.type }}
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem @click="router.push(`/tickets?assignee=${auth.me?.id}`)">
            <Inbox class="h-4 w-4 mr-2" /> My tickets
          </DropdownMenuItem>
          <DropdownMenuItem @click="router.push('/settings')">
            <SettingsIcon class="h-4 w-4 mr-2" /> Settings
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem @click="logout">
            <LogOut class="h-4 w-4 mr-2" /> Log out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  </header>
</template>
