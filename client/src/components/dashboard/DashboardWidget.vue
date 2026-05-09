<script setup lang="ts">
// Card wrapper for dashboard widgets. Each widget renders independently —
// errors and skeletons stay scoped so a flaky one can't blank the whole
// page. Title + optional `actions` slot in the header; default slot is the
// body. `loading` and `error` props short-circuit to consistent placeholders.

import { Loader2, AlertCircle } from "lucide-vue-next";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

defineProps<{
  title: string;
  loading?: boolean;
  error?: unknown;
  // For widgets that should render their own padding/structure (e.g. the
  // KPI strip card already has special internals). Setting `padded=false`
  // strips the default body padding.
  padded?: boolean;
}>();
</script>

<template>
  <Card class="flex flex-col">
    <CardHeader class="flex-row items-center justify-between space-y-0 py-3 px-4 border-b">
      <CardTitle class="text-sm font-medium tracking-tight flex items-center gap-2">
        <slot name="title-prefix" />
        {{ title }}
        <slot name="title-suffix" />
      </CardTitle>
      <div class="flex items-center gap-1">
        <slot name="actions" />
      </div>
    </CardHeader>
    <CardContent
      class="flex-1 min-h-0"
      :class="padded === false ? 'p-0' : 'p-4'"
    >
      <div v-if="loading" class="space-y-2">
        <Skeleton class="h-4 w-1/2" />
        <Skeleton class="h-4 w-2/3" />
        <Skeleton class="h-4 w-1/3" />
      </div>
      <div
        v-else-if="error"
        class="flex flex-col items-center justify-center py-6 text-xs text-muted-foreground"
      >
        <AlertCircle class="h-5 w-5 text-destructive mb-1.5" />
        <span>Couldn't load this widget.</span>
      </div>
      <slot v-else />
    </CardContent>
  </Card>
</template>
