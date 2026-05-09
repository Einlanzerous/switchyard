<script setup lang="ts">
import type { FunctionalComponent, SVGAttributes } from "vue";
import { cn } from "@/lib/utils";

// `icon` is optional. When set, it renders before the label inside each chip
// (used for the Type filter so the visual matches the row icon).
type Option = {
  value: string;
  label: string;
  icon?: FunctionalComponent<SVGAttributes>;
};

defineProps<{
  label: string;
  options: Option[];
  selected: string[];
}>();

defineEmits<{
  toggle: [value: string];
}>();
</script>

<template>
  <div class="inline-flex items-center gap-1.5">
    <span class="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
      {{ label }}
    </span>
    <div class="inline-flex flex-wrap gap-1">
      <button
        v-for="o in options"
        :key="o.value"
        type="button"
        :class="cn(
          'inline-flex h-6 items-center gap-1 rounded-md border px-2 text-xs font-medium transition-colors',
          selected.includes(o.value)
            ? 'bg-primary text-primary-foreground border-primary'
            : 'bg-background text-muted-foreground hover:bg-accent hover:text-foreground border-border',
        )"
        @click="$emit('toggle', o.value)"
      >
        <component :is="o.icon" v-if="o.icon" class="h-3.5 w-3.5" />
        {{ o.label }}
      </button>
    </div>
  </div>
</template>
