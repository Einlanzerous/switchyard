<script setup lang="ts">
// Reusable empty-state for lists, widgets, and panels. Centers an icon,
// a title, an optional description, and an optional `action` slot for a
// CTA button. Sized via the `size` prop so it fits both whole-page empty
// surfaces (e.g. an empty tickets list) and small in-card surfaces
// (e.g. a comment list with no comments).

import type { Component } from "vue";
import { computed } from "vue";

const props = defineProps<{
  // Lucide icon component. Optional — text-only empty states (e.g. a
  // table cell) can omit it.
  icon?: Component;
  title: string;
  description?: string;
  // sm = compact (in-card / drawer); md = page-level. Defaults to md.
  size?: "sm" | "md";
}>();

const sizeMap = computed(() => ({
  sm: { wrap: "py-6", icon: "h-5 w-5 mb-1.5", title: "text-xs font-medium", desc: "text-[11px] mt-0.5" },
  md: { wrap: "p-8", icon: "h-9 w-9 mb-2.5", title: "text-sm font-medium", desc: "text-xs mt-1" },
}[props.size ?? "md"]));
</script>

<template>
  <div :class="['flex flex-col items-center justify-center text-center', sizeMap.wrap]">
    <component
      v-if="icon"
      :is="icon"
      :class="['text-muted-foreground/40', sizeMap.icon]"
      aria-hidden="true"
    />
    <h3 :class="sizeMap.title">{{ title }}</h3>
    <p
      v-if="description"
      :class="['text-muted-foreground', sizeMap.desc]"
    >{{ description }}</p>
    <div v-if="$slots.action" class="mt-3">
      <slot name="action" />
    </div>
  </div>
</template>
