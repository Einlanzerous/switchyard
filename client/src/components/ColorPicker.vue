<script setup lang="ts">
// Compact swatch-trigger color picker. Click the small swatch to open a
// popover containing the curated palette + a hex input override. Used by
// SettingsLabels + SettingsProject + SettingsProjects + ProjectSetupSettings.
//
// Palette stays within the contrast-guard luminance bounds defined in
// shared/src/schemas/common.ts:HexColor — every swatch here will pass the
// server-side refinement. Constant + helpers live in ./colorPalette.ts
// because <script setup> can't host ES exports.

import { computed, ref } from "vue";
import { ChevronDown } from "lucide-vue-next";
import {
  Popover, PopoverContent, PopoverTrigger,
} from "@/components/ui/popover";
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

const open = ref(false);

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
  open.value = false;
}

function onInput(v: string) {
  emit("update:modelValue", v);
}
</script>

<template>
  <Popover v-model:open="open">
    <PopoverTrigger as-child>
      <button
        type="button"
        :class="[
          'inline-flex items-center gap-2 rounded-md border bg-background px-2 py-1 text-xs transition-colors',
          error ? 'border-destructive' : 'hover:bg-accent/40',
        ]"
      >
        <span
          class="inline-block h-4 w-4 rounded border shrink-0"
          :style="modelValue ? { backgroundColor: modelValue } : undefined"
        />
        <span class="font-mono text-muted-foreground tabular-nums">
          {{ modelValue || "—" }}
        </span>
        <ChevronDown class="h-3 w-3 text-muted-foreground" />
      </button>
    </PopoverTrigger>
    <PopoverContent align="start" class="w-56 p-3 space-y-2">
      <div class="grid grid-cols-6 gap-1.5">
        <button
          v-for="c in SWATCHES"
          :key="c"
          type="button"
          class="relative h-7 w-7 rounded-md border-2 transition"
          :class="[
            modelValue.toLowerCase() === c.toLowerCase() ? 'border-foreground' : 'border-transparent',
            usedSet.has(c.toLowerCase()) && modelValue.toLowerCase() !== c.toLowerCase() ? 'opacity-50' : '',
          ]"
          :style="{ backgroundColor: c }"
          :title="usedSet.has(c.toLowerCase()) ? `${c} (in use elsewhere)` : c"
          @click="pick(c)"
        />
      </div>
      <Input
        :model-value="modelValue"
        class="font-mono text-xs h-7"
        placeholder="#3b82f6"
        maxlength="7"
        @update:model-value="onInput(String($event))"
      />
      <p v-if="error" class="text-[11px] text-destructive">{{ error }}</p>
    </PopoverContent>
  </Popover>
</template>
