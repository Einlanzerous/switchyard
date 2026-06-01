<script setup lang="ts">
import type { PrimitiveProps } from "reka-ui"
import type { ButtonHTMLAttributes, HTMLAttributes } from "vue"
import type { ButtonVariants } from "."
import { Primitive } from "reka-ui"
import { cn } from "@/lib/utils"
import { buttonVariants } from "."

interface Props extends PrimitiveProps {
  variant?: ButtonVariants["variant"]
  size?: ButtonVariants["size"]
  class?: HTMLAttributes["class"]
}

// Native button/anchor attributes (disabled, type, title, aria-*, on*, …) reach
// the rendered element via attribute fallthrough. ButtonHTMLAttributes is added
// as a separate `@vue-ignore` intersection member (NOT in the interface's extends
// list — that would poison resolution of PrimitiveProps and drop `as`): it keeps
// these out of the runtime props declaration so they stay in $attrs and fall
// through, while still making strictTemplates accept them at call sites.
const props = withDefaults(
  defineProps<Props & /* @vue-ignore */ ButtonHTMLAttributes>(),
  { as: "button" },
)
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
