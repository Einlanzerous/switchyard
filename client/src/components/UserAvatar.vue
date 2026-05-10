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
import { computeInitials } from "@/lib/initials";

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

const initials = computed(() => computeInitials(props.user?.name));

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
    <!--
      reka-ui's AvatarFallback is content-sized by default — without
      explicit h-full/w-full + flex centering, the inline backgroundColor
      paints only a tight box around the initials and the parent's
      bg-secondary shows through as a ring. These classes make the
      colored chip fill the whole circle, Jira-style.
    -->
    <!--
      `leading-none` is load-bearing — without it, the line-box's default
      leading pads the bottom of capital letters (M / N especially) and
      shifts them low even though they're flex-centered. Tracking-wide
      keeps two-letter pairs from looking cramped.
    -->
    <AvatarFallback
      :style="{ backgroundColor: color, color: '#fff' }"
      class="flex h-full w-full items-center justify-center font-medium leading-none tracking-wide"
    >
      {{ initials }}
    </AvatarFallback>
  </Avatar>
</template>
