<script setup lang="ts" generic="V extends string">
// Generic single-select sort dropdown. Used by:
//   - TicketsView: server-side sort_by selector (with a separate direction toggle).
//   - ProjectBoardView / BoardView: client-side compareTickets mode selector.
//
// The trigger shows the active option's label so the active sort is obvious
// at a glance. Selected item gets a check.
import { computed } from "vue";
import { ArrowUpDown, Check } from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuLabel, DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";

const props = defineProps<{
  modelValue: V;
  options: { value: V; label: string }[];
  label?: string;
}>();
const emit = defineEmits<{ "update:modelValue": [V] }>();

const activeLabel = computed(
  () => props.options.find((o) => o.value === props.modelValue)?.label ?? "Sort",
);
</script>

<template>
  <DropdownMenu>
    <DropdownMenuTrigger as-child>
      <Button variant="outline" size="sm" class="h-8 gap-1.5 text-xs font-normal">
        <ArrowUpDown class="h-3.5 w-3.5" />
        <span class="text-muted-foreground">{{ label ?? "Sort" }}:</span>
        <span class="font-medium">{{ activeLabel }}</span>
      </Button>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="end" class="w-52">
      <DropdownMenuLabel class="text-xs text-muted-foreground">{{ label ?? "Sort by" }}</DropdownMenuLabel>
      <DropdownMenuSeparator />
      <DropdownMenuItem
        v-for="opt in options"
        :key="opt.value"
        class="gap-2"
        @click="emit('update:modelValue', opt.value)"
      >
        <Check
          class="h-3.5 w-3.5"
          :class="opt.value === modelValue ? 'opacity-100' : 'opacity-0'"
        />
        <span>{{ opt.label }}</span>
      </DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>
</template>
