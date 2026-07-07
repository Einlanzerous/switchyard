<script setup lang="ts">
// Shared user-avatar component. Wraps the shadcn Avatar / AvatarFallback
// pair with stable per-user background colors and right-sized initials.
// Pass a UserRef-shaped object (or any { id?, name, type? }) and a size
// token.
//
// v4 actor system: **squares are agents, circles are people.** When the
// user carries `type: "agent"` the avatar renders as a rounded square in
// the steel agent tint with a lowercase mono handle ("cl" for claude);
// humans keep the warm-colored circle. Shape is driven by the user's type
// so every call site picks it up without opting in.
//
// Use this anywhere the app shows an actor's avatar. Passing `null` /
// undefined renders a neutral "—" placeholder (assignee unset, etc.).

import { computed } from "vue";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { avatarColorFor } from "@/lib/avatarColor";
import { computeAgentInitials, computeInitials } from "@/lib/initials";
import { cn } from "@/lib/utils";

type UserLike = {
  id?: string;
  name?: string | null;
  icon?: string | null;
  type?: string | null;
};

const props = defineProps<{
  user?: UserLike | null;
  size?: "xs" | "sm" | "md" | "lg";
  title?: string;
}>();

const isAgent = computed(() => props.user?.type === "agent");

const initials = computed(() =>
  isAgent.value
    ? computeAgentInitials(props.user?.name)
    : computeInitials(props.user?.name),
);

// Per-user chip color — humans only; agents and the "no user" placeholder
// get theme-aware utility classes instead (see fallbackClasses).
const color = computed(() =>
  props.user ? avatarColorFor(props.user.id ?? props.user.name ?? "") : null,
);

// Size tokens map to the same h/w/text combinations the existing direct
// Avatar usages picked. Defaults to `sm` (h-6 w-6) which is the most
// common across the codebase.
const sizeClasses = computed(() => ({
  xs: "h-5 w-5 text-[9px]",
  sm: "h-6 w-6 text-[10px]",
  md: "h-7 w-7 text-[11px]",
  lg: "h-8 w-8 text-xs",
}[props.size ?? "sm"]));

// Agent squares use a 6px corner (the design's .av.sq) — tighter than the
// shadcn `square` variant's rounded-md, and scaled down for xs. The steel
// ring is a real border on the ROOT so it follows the rounded corners — an
// inset shadow on the (unrounded) fallback gets clipped square at the
// corners and reads as "cut off".
const shapeClasses = computed(() =>
  isAgent.value
    ? cn(
        props.size === "xs" ? "rounded-[5px]" : "rounded-[6px]",
        "border border-agent/30",
      )
    : "",
);

// Agents and the "no user" ghost ride the theme-aware v4 tokens (SWY-158:
// agent steel / ink-4 flip between light and dark); human chips keep their
// stable per-user inline color, which reads fine on both themes.
const fallbackStyle = computed(() =>
  color.value && !isAgent.value
    ? { backgroundColor: color.value, color: "#fff" }
    : undefined,
);

const fallbackClasses = computed(() =>
  isAgent.value ? "bg-agent-bg text-agent" : !props.user ? "bg-ink-4 text-white" : "",
);

const ariaTitle = computed(() => props.title ?? props.user?.name ?? undefined);
</script>

<template>
  <!-- @vue-expect-error reka-ui Avatar forwards the global title attribute at runtime but doesn't type it -->
  <Avatar
    :shape="isAgent ? 'square' : 'circle'"
    :class="cn(sizeClasses, shapeClasses)"
    :title="ariaTitle"
  >
    <!-- AvatarImage falls through to AvatarFallback automatically when the
         src 404s or is empty, so this block is safe even if user.icon is
         a junk URL. -->
    <!-- @vue-expect-error reka-ui AvatarImage forwards the native img alt attribute at runtime but doesn't type it -->
    <AvatarImage v-if="user?.icon" :src="user.icon" :alt="user?.name ?? ''" />
    <!--
      reka-ui's AvatarFallback is content-sized by default — without
      explicit h-full/w-full + flex centering, the inline backgroundColor
      paints only a tight box around the initials and the parent's
      bg-secondary shows through as a ring. These classes make the
      colored chip fill the whole circle, Jira-style.

      The agent border is an inset box-shadow rather than a real border so
      it doesn't eat into the (already tiny) content box.
    -->
    <!--
      `leading-none` is load-bearing — without it, the line-box's default
      leading pads the bottom of capital letters (M / N especially) and
      shifts them low even though they're flex-centered. Tracking-wide
      keeps two-letter pairs from looking cramped.
    -->
    <AvatarFallback
      :style="fallbackStyle"
      :class="cn(
        'flex h-full w-full items-center justify-center leading-none',
        isAgent ? 'font-mono font-medium tracking-tight' : 'font-medium tracking-wide',
        fallbackClasses,
      )"
    >
      {{ initials }}
    </AvatarFallback>
  </Avatar>
</template>
