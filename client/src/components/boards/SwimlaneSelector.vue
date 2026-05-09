<script setup lang="ts">
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";

export type SwimlaneBy = "none" | "project" | "assignee" | "type";

defineProps<{ modelValue: SwimlaneBy }>();
defineEmits<{ "update:modelValue": [value: SwimlaneBy] }>();

const OPTIONS: Array<{ value: SwimlaneBy; label: string }> = [
  { value: "none", label: "No swimlanes" },
  { value: "project", label: "Project" },
  { value: "assignee", label: "Assignee" },
  { value: "type", label: "Type" },
];
</script>

<template>
  <Select
    :model-value="modelValue"
    @update:model-value="(v) => $emit('update:modelValue', v as SwimlaneBy)"
  >
    <SelectTrigger class="h-8 w-[10rem]">
      <span class="text-xs text-muted-foreground mr-1">Group by</span>
      <SelectValue />
    </SelectTrigger>
    <SelectContent>
      <SelectItem v-for="o in OPTIONS" :key="o.value" :value="o.value">
        {{ o.label }}
      </SelectItem>
    </SelectContent>
  </Select>
</template>
