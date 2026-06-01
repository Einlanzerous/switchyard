<script setup lang="ts">
import type { HTMLAttributes, InputHTMLAttributes } from "vue"
import { useVModel } from "@vueuse/core"
import { cn } from "@/lib/utils"

// Native <input> attributes that fall through to the element. A curated subset
// rather than the full InputHTMLAttributes: the full ~220-member type, merged as
// $attrs fallthrough onto the single native-input root, overflows vue-tsc's
// union representation (TS2590). `@vue-ignore` keeps these out of the runtime
// props declaration (so they stay in $attrs and fall through) while letting
// strictTemplates accept them at call sites.
type NativeInputAttrs = Pick<
  InputHTMLAttributes,
  | "id" | "name" | "type" | "value" | "placeholder" | "autocomplete"
  | "autofocus" | "disabled" | "readonly" | "required" | "spellcheck"
  | "inputmode" | "list" | "min" | "max" | "step" | "maxlength" | "minlength"
  | "pattern" | "size" | "multiple" | "accept"
  | "onBlur" | "onFocus" | "onChange" | "onKeydown" | "onKeyup"
>

interface Props extends /* @vue-ignore */ NativeInputAttrs {
  defaultValue?: string | number
  modelValue?: string | number
  // Present so `v-model.trim`/`.number` call sites typecheck under strictTemplates.
  modelModifiers?: Record<string, boolean>
  class?: HTMLAttributes["class"]
}

const props = defineProps<Props>()

const emits = defineEmits<{
  (e: "update:modelValue", payload: string | number): void
}>()

// Narrow the props handed to useVModel — inferring its generics over the full
// NativeInputAttrs-extended type overflows vue-tsc's union representation
// (TS2590). v-model is kept (not :value/@input) so IME composition still works.
const vmodelProps = props as { modelValue?: string | number; defaultValue?: string | number }
const modelValue = useVModel(vmodelProps, "modelValue", emits, {
  passive: true,
  defaultValue: vmodelProps.defaultValue,
})
</script>

<template>
  <!-- @vue-expect-error vue-tsc can't represent this input's intrinsic attributes
       merged with the wide $attrs fallthrough (TS2590). v-model is correct at
       runtime and kept (over :value/@input) so IME composition still works. -->
  <input v-model="modelValue" :class="cn('flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background file:border-0 file:bg-transparent file:text-foreground file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50', props.class)">
</template>
