<script setup lang="ts">
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";

export type SwimlaneBy = "none" | "project" | "assignee" | "type";

defineProps<{ modelValue: SwimlaneBy }>();
defineEmits<{ "update:modelValue": [value: SwimlaneBy] }>();

const OPTIONS: Array<{ value: SwimlaneBy; label: string }> = [
  { value: "none", label: "None" },
  { value: "project", label: "Project" },
  { value: "assignee", label: "Assignee" },
  { value: "type", label: "Type" },
];
</script>

<template>
  <!-- v4: reads as the mock's ghost "Group: X" button (value bolded). -->
  <Select
    :model-value="modelValue"
    @update:model-value="(v) => $emit('update:modelValue', v as SwimlaneBy)"
  >
    <SelectTrigger
      class="h-8 w-auto gap-1 border-transparent bg-transparent px-2.5 text-[12.5px] shadow-none hover:bg-accent"
    >
      <span class="text-muted-foreground">Group:</span>
      <span class="font-semibold"><SelectValue /></span>
    </SelectTrigger>
    <SelectContent>
      <SelectItem v-for="o in OPTIONS" :key="o.value" :value="o.value">
        {{ o.label }}
      </SelectItem>
    </SelectContent>
  </Select>
</template>
