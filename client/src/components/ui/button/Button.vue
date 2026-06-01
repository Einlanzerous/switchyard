<script setup lang="ts">
import type { PrimitiveProps } from "reka-ui"
import type { ButtonHTMLAttributes, HTMLAttributes } from "vue"
import type { ButtonVariants } from "."
import { Primitive } from "reka-ui"
import { cn } from "@/lib/utils"
import { buttonVariants } from "."

// Native button/anchor attributes (disabled, type, title, aria-*, on*, …) reach
// the rendered element via attribute fallthrough. `@vue-ignore` keeps them out
// of the runtime props declaration — so they stay in $attrs and fall through —
// while still making strictTemplates accept them at call sites.
interface Props extends PrimitiveProps, /* @vue-ignore */ ButtonHTMLAttributes {
  variant?: ButtonVariants["variant"]
  size?: ButtonVariants["size"]
  class?: HTMLAttributes["class"]
}

const props = withDefaults(defineProps<Props>(), {
  as: "button",
})
</script>

<template>
  <Primitive
    :as="as"
    :as-child="asChild"
    :class="cn(buttonVariants({ variant, size }), props.class)"
  >
    <slot />
  </Primitive>
</template>
