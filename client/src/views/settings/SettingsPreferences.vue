<script setup lang="ts">
import { Sun, Moon, Monitor } from "lucide-vue-next";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useThemeStore } from "@/stores/theme";
import { cn } from "@/lib/utils";

const theme = useThemeStore();

// useColorMode stores `light` | `dark` | `auto`; "auto" follows the OS.
const options = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "auto", label: "System", icon: Monitor },
] as const;
</script>

<template>
  <div class="space-y-4">
    <header>
      <h2 class="text-xl font-semibold tracking-tight">Preferences</h2>
      <p class="text-sm text-muted-foreground">
        Personal settings for how switchyard looks on this device.
      </p>
    </header>

    <Card>
      <CardHeader>
        <CardTitle class="text-base">Appearance</CardTitle>
        <CardDescription>
          Choose a theme. “System” follows your operating system setting.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div
          role="radiogroup"
          aria-label="Theme"
          class="inline-flex rounded-md border bg-muted/50 p-1"
        >
          <button
            v-for="opt in options"
            :key="opt.value"
            type="button"
            role="radio"
            :aria-checked="theme.mode === opt.value"
            :class="cn(
              'flex items-center gap-2 rounded px-3 py-1.5 text-sm transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-ring',
              theme.mode === opt.value
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
            )"
            @click="theme.mode = opt.value"
          >
            <component :is="opt.icon" class="h-4 w-4" />
            {{ opt.label }}
          </button>
        </div>
      </CardContent>
    </Card>
  </div>
</template>
