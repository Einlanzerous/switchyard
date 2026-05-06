<script setup lang="ts">
import { Search, Sun, Moon, Monitor, LogOut, User as UserIcon } from "lucide-vue-next";
import { computed } from "vue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { useThemeStore } from "@/stores/theme";
import { useAuthStore } from "@/stores/auth";
import { useRouter } from "vue-router";

const theme = useThemeStore();
const auth = useAuthStore();
const router = useRouter();

const initials = computed(() => {
  const name = auth.me?.name ?? "?";
  return name
    .split(/\s+/)
    .map((p) => p[0]?.toUpperCase() ?? "")
    .slice(0, 2)
    .join("");
});

function logout() {
  auth.logout();
  router.push("/login");
}
</script>

<template>
  <header class="flex h-14 items-center gap-3 border-b px-4">
    <div class="flex-1 max-w-md">
      <div class="relative">
        <Search class="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Search tickets…  ⌘K"
          class="pl-9 bg-muted/50 border-transparent focus-visible:ring-1"
          disabled
          aria-label="Search (command palette wires up in milestone 2.7)"
        />
      </div>
    </div>

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
          <Avatar class="h-8 w-8">
            <AvatarFallback>{{ initials }}</AvatarFallback>
          </Avatar>
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
  </header>
</template>
