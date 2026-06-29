<script setup lang="ts">
import { computed } from "vue";
import type { PlanDiff } from "@switchyard/shared";

// Renders the render-time diff of a revision against its predecessor — the
// "intent diff". Narrative is a line-level add/remove/context stream; criteria
// are add/remove/change/unchanged rows. No stable per-criterion identity in v1,
// so a "changed" row carries the predecessor text inline.
const props = defineProps<{
  diff: PlanDiff;
}>();

const hasNarrativeChange = computed(() =>
  props.diff.narrative.some((l) => l.type !== "context"),
);
const hasCriteriaChange = computed(() =>
  props.diff.criteria.some((c) => c.type !== "unchanged"),
);
</script>

<template>
  <div class="space-y-4 text-sm">
    <p class="text-xs text-muted-foreground">
      Changes since revision {{ diff.from_rev_number }}.
    </p>

    <!-- Narrative diff -->
    <section v-if="hasNarrativeChange">
      <h4 class="text-[11px] uppercase tracking-wider text-muted-foreground mb-1.5">Narrative</h4>
      <pre class="overflow-x-auto rounded-md border bg-muted/30 p-2 text-xs leading-relaxed font-mono"><template
        v-for="(line, i) in diff.narrative"
        :key="i"
      ><span
        :class="{
          'block px-1': true,
          'bg-green-500/15 text-green-700 dark:text-green-300': line.type === 'added',
          'bg-red-500/15 text-red-700 dark:text-red-300 line-through/0': line.type === 'removed',
          'text-muted-foreground': line.type === 'context',
        }"
      >{{ line.type === 'added' ? '+' : line.type === 'removed' ? '−' : ' ' }} {{ line.text || ' ' }}</span></template></pre>
    </section>

    <!-- Criteria diff -->
    <section v-if="hasCriteriaChange">
      <h4 class="text-[11px] uppercase tracking-wider text-muted-foreground mb-1.5">Acceptance criteria</h4>
      <ul class="space-y-1">
        <li
          v-for="(c, i) in diff.criteria"
          :key="i"
          :class="{
            'flex gap-2 rounded px-2 py-1 text-xs': true,
            'bg-green-500/10 text-green-800 dark:text-green-300': c.type === 'added',
            'bg-red-500/10 text-red-800 dark:text-red-300': c.type === 'removed',
            'bg-amber-500/10 text-amber-800 dark:text-amber-300': c.type === 'changed',
            'text-muted-foreground': c.type === 'unchanged',
          }"
        >
          <span class="select-none font-mono">
            {{ c.type === 'added' ? '+' : c.type === 'removed' ? '−' : c.type === 'changed' ? '~' : ' ' }}
          </span>
          <span class="min-w-0">
            <span v-if="c.type === 'changed' && c.prev_text" class="block line-through opacity-60">{{ c.prev_text }}</span>
            <span class="block">{{ c.text }}</span>
          </span>
        </li>
      </ul>
    </section>

    <p v-if="!hasNarrativeChange && !hasCriteriaChange" class="text-xs text-muted-foreground italic">
      No textual changes from the previous revision.
    </p>
  </div>
</template>
