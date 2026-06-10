<script setup lang="ts">
// Checklist of token scopes, shared by every mint surface (self tokens, admin
// invite/mint). v-model is the selected Set — toggling emits a fresh Set so
// callers stay reactive without mutating the prop.
import { Checkbox } from "@/components/ui/checkbox";
import { SCOPE_OPTIONS } from "@/lib/tokenScopes";
import type { ApiTokenScope } from "@switchyard/shared";

const props = defineProps<{ modelValue: Set<ApiTokenScope> }>();
const emit = defineEmits<{ "update:modelValue": [Set<ApiTokenScope>] }>();

function toggle(s: ApiTokenScope) {
  const next = new Set(props.modelValue);
  if (next.has(s)) next.delete(s);
  else next.add(s);
  emit("update:modelValue", next);
}
</script>

<template>
  <ul class="rounded-md border max-h-56 overflow-auto divide-y">
    <li
      v-for="o in SCOPE_OPTIONS"
      :key="o.value"
      class="flex items-start gap-2 px-3 py-2 text-sm hover:bg-accent/40 cursor-pointer"
      @click="toggle(o.value)"
    >
      <Checkbox
        :model-value="modelValue.has(o.value)"
        class="mt-0.5"
        @click.stop="toggle(o.value)"
      />
      <div class="flex-1 min-w-0">
        <div class="font-mono text-[12px]">{{ o.label }}</div>
        <div class="text-[11px] text-muted-foreground">{{ o.help }}</div>
      </div>
    </li>
  </ul>
</template>
