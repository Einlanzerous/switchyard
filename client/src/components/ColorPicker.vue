<script setup lang="ts">
// Swatch grid + hex input. Same pattern used by SettingsLabels +
// SettingsProjects + ProjectSetupSettings. The palette is curated to stay
// within the contrast-guard luminance bounds defined in
// shared/src/schemas/common.ts:HexColor — every swatch here will pass the
// server-side refinement. Constant + helpers live in ./colorPalette.ts
// because <script setup> can't host ES exports.

import { computed } from "vue";
import { Input } from "@/components/ui/input";
import { isContrastSafe } from "@switchyard/shared";
import { SWATCHES } from "./colorPalette";

const props = defineProps<{
  modelValue: string;
  used?: Iterable<string | null | undefined>;
}>();

const emit = defineEmits<{
  (e: "update:modelValue", value: string): void;
}>();

const usedSet = computed(() => {
  if (!props.used) return new Set<string>();
  return new Set(
    Array.from(props.used)
      .filter((c): c is string => typeof c === "string")
      .map((c) => c.toLowerCase()),
  );
});

const HEX_RE = /^#[0-9a-fA-F]{6}$/;
const validHex = computed(() => HEX_RE.test(props.modelValue));
const validContrast = computed(
  () => validHex.value && isContrastSafe(props.modelValue),
);
const error = computed(() => {
  if (!props.modelValue) return null;
  if (!validHex.value) return "Color must be a 6-digit hex like #3b82f6.";
  if (!validContrast.value) {
    return "Too close to a theme background — pick a less extreme color.";
  }
  return null;
});

function pick(c: string) {
  emit("update:modelValue", c);
}

function onInput(v: string) {
  emit("update:modelValue", v);
}
</script>

<template>
  <div class="space-y-1.5">
    <div class="flex flex-wrap gap-1.5">
      <button
        v-for="c in SWATCHES"
        :key="c"
        type="button"
        class="relative h-7 w-7 rounded-md border-2 transition"
        :class="[
          modelValue.toLowerCase() === c.toLowerCase() ? 'border-foreground' : 'border-transparent',
          usedSet.has(c.toLowerCase()) ? 'opacity-50' : '',
        ]"
        :style="{ backgroundColor: c }"
        :title="usedSet.has(c.toLowerCase()) ? `${c} (in use)` : c"
        @click="pick(c)"
      />
    </div>
    <Input
      :model-value="modelValue"
      class="font-mono text-xs"
      placeholder="#3b82f6"
      maxlength="7"
      @update:model-value="onInput(String($event))"
    />
    <p v-if="error" class="text-xs text-destructive">{{ error }}</p>
  </div>
</template>
