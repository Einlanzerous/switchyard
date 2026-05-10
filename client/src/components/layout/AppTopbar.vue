<script setup lang="ts">
import { Search, Sun, Moon, Monitor, LogOut, User as UserIcon } from "lucide-vue-next";
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
import { useThemeStore } from "@/stores/theme";
import { useAuthStore } from "@/stores/auth";
import { useUiStore } from "@/stores/ui";
import { useRouter } from "vue-router";

const theme = useThemeStore();
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
  <header class="flex h-16 items-center gap-3 border-b px-4">
    <div class="flex-1" aria-hidden="true" />

    <div class="w-full max-w-2xl">
      <button
        type="button"
        class="relative w-full h-11 rounded-md border border-transparent bg-muted/50 hover:bg-muted text-left text-sm text-muted-foreground px-3 transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-ring flex items-center gap-2"
        aria-label="Open command palette"
        @click="ui.openPalette()"
      >
        <kbd class="hidden sm:inline-flex h-6 select-none items-center gap-1 rounded border bg-background px-1.5 font-mono text-[10px] font-medium text-muted-foreground shrink-0">
          Ctrl+K
        </kbd>
        <Search class="h-4 w-4 shrink-0" />
        <span class="truncate">Search tickets, projects, boards…</span>
      </button>
    </div>

    <div class="flex-1 flex items-center justify-end gap-2">
      <NotificationsBell v-if="auth.isAuthenticated" />

      <Button
        variant="ghost"
        size="icon"
        :aria-label="`Theme: ${theme.mode}`"
        @click="theme.cycle"
      >
        <Sun v-if="theme.mode === 'light'" class="h-4 w-4" />
        <Moon v-else-if="theme.mode === 'dark'" class="h-4 w-4" />
        <Monitor v-else class="h-4 w-4" />
      </Button>

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
          <DropdownMenuItem @click="router.push('/settings')">
            <UserIcon class="h-4 w-4 mr-2" /> Settings
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
