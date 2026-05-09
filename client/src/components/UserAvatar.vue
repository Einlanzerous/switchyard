<script setup lang="ts">
// Shared user-avatar component. Wraps the shadcn Avatar / AvatarFallback
// pair with stable per-user background colors and right-sized initials.
// Pass a UserRef-shaped object (or any { id?, name }) and a size token.
//
// Use this anywhere the app shows a person's avatar. Passing `null` /
// undefined renders a neutral gray "—" placeholder (assignee unset, etc.).

import { computed } from "vue";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { avatarColorFor } from "@/lib/avatarColor";

type UserLike = {
  id?: string;
  name?: string | null;
  icon?: string | null;
};

const props = defineProps<{
  user?: UserLike | null;
  size?: "xs" | "sm" | "md" | "lg";
  title?: string;
}>();

const initials = computed(() => {
  const name = props.user?.name ?? "";
  if (!name) return "—";
  return name
    .split(/\s+/)
    .map((p) => p[0]?.toUpperCase() ?? "")
    .slice(0, 2)
    .join("") || "—";
});

const color = computed(() => {
  if (!props.user) return "#6b7280";
  return avatarColorFor(props.user.id ?? props.user.name ?? "");
});

// Size tokens map to the same h/w/text combinations the existing direct
// Avatar usages picked. Defaults to `sm` (h-6 w-6) which is the most
// common across the codebase.
const sizeClasses = computed(() => ({
  xs: "h-5 w-5 text-[9px]",
  sm: "h-6 w-6 text-[10px]",
  md: "h-7 w-7 text-[11px]",
  lg: "h-8 w-8 text-xs",
}[props.size ?? "sm"]));

const ariaTitle = computed(() => props.title ?? props.user?.name ?? undefined);
</script>

<template>
  <Avatar :class="sizeClasses" :title="ariaTitle">
    <!-- AvatarImage falls through to AvatarFallback automatically when the
         src 404s or is empty, so this block is safe even if user.icon is
         a junk URL. -->
    <AvatarImage v-if="user?.icon" :src="user.icon" :alt="user?.name ?? ''" />
    <AvatarFallback
      :style="{ backgroundColor: color, color: '#fff' }"
      class="font-medium"
    >
      {{ initials }}
    </AvatarFallback>
  </Avatar>
</template>
