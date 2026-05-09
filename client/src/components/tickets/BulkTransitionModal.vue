<script setup lang="ts">
// Bulk-transition modal. Two-step flow that handles the cross-project case
// the user called out:
//
//   1. Pick a status category (5 options — backlog/planning/in_progress/blocked/closed).
//   2. Per project in the selection, the modal auto-resolves to the only
//      status in that category if there's a single match, or shows a
//      dropdown if the project has multiple statuses in that category.
//   3. If category=closed, an additional resolution selector (done/released/cancelled)
//      is required because the transition endpoint mandates it.
//
// Behind the scenes: per-ticket POST /v1/tickets/:idOrKey/transition with
// the resolved per-project status_id.

import { computed, ref, watch } from "vue";
import { useQueries, useQueryClient } from "@tanstack/vue-query";
import { Loader2, MoveRight } from "lucide-vue-next";
import { toast } from "vue-sonner";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { api } from "@/lib/api";
import { queryKeys } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import type { TicketSummary, Status, StatusCategory, Resolution } from "@switchyard/shared";

const props = defineProps<{
  open: boolean;
  selectedTickets: TicketSummary[];
  projectKeys: string[];
}>();

const emit = defineEmits<{
  "update:open": [value: boolean];
  done: [];
}>();

const qc = useQueryClient();

// ─── per-project statuses ──────────────────────────────────────────────────
//
// One useQuery per distinct project key. useQueries lets us key on the same
// `projectStatuses(key)` cache slot the rest of the app uses, so this
// piggybacks on cached data the moment a project board has been visited.

const statusQueries = useQueries({
  queries: computed(() =>
    props.projectKeys.map((key) => ({
      queryKey: queryKeys.projectStatuses(key),
      enabled: props.open,
      staleTime: 5 * 60 * 1000,
      queryFn: async () => {
        const { data, error } = await api.GET("/v1/projects/{key}/statuses", {
          params: { path: { key } },
        });
        if (error) throw error;
        return { key, items: (data?.items ?? []) as Status[] };
      },
    }))
  ),
});

// projectKey → status[] grouped by category
type ByCategory = Record<StatusCategory, Status[]>;
const statusesByProject = computed<Map<string, ByCategory>>(() => {
  const out = new Map<string, ByCategory>();
  for (let i = 0; i < statusQueries.value.length; i++) {
    const q = statusQueries.value[i];
    if (!q?.data) continue;
    const grouped: ByCategory = {
      backlog: [], planning: [], in_progress: [], blocked: [], closed: [],
    };
    for (const s of q.data.items) {
      const cat = s.category as StatusCategory;
      grouped[cat].push(s);
    }
    // Sort each bucket by position so the lowest-position is the obvious default.
    for (const cat of Object.keys(grouped) as StatusCategory[]) {
      grouped[cat].sort((a, b) => a.position - b.position);
    }
    out.set(q.data.key, grouped);
  }
  return out;
});

const allLoaded = computed(() =>
  statusQueries.value.length > 0 && statusQueries.value.every((q) => !!q.data)
);

// ─── state ─────────────────────────────────────────────────────────────────

const CATEGORIES: { value: StatusCategory; label: string }[] = [
  { value: "backlog", label: "Backlog" },
  { value: "planning", label: "Planning" },
  { value: "in_progress", label: "In Progress" },
  { value: "blocked", label: "Blocked" },
  { value: "closed", label: "Closed" },
];

const category = ref<StatusCategory | null>(null);
const resolution = ref<Resolution>("done");
const submitting = ref(false);

// projectKey → chosen status_id. Auto-resolves when a project has exactly
// one status in the chosen category; required choice when multiple.
const perProject = ref<Map<string, string>>(new Map());

// Reset on open / when category changes; auto-resolve where possible.
watch(
  () => [props.open, category.value, statusesByProject.value] as const,
  () => {
    if (!props.open) {
      category.value = null;
      perProject.value = new Map();
      return;
    }
    if (!category.value) return;
    const next = new Map<string, string>();
    for (const key of props.projectKeys) {
      const grouped = statusesByProject.value.get(key);
      if (!grouped) continue;
      const inCat = grouped[category.value];
      if (inCat.length === 1) next.set(key, inCat[0]!.id);
      else if (inCat.length > 1) {
        // Default to lowest-position; user can override via the dropdown.
        next.set(key, inCat[0]!.id);
      }
      // length === 0 → leave unset; we surface a warning row in the UI.
    }
    perProject.value = next;
  }
);

// True when every project in the selection has a usable status mapped.
const fullyMapped = computed(() => {
  if (!category.value) return false;
  for (const key of props.projectKeys) {
    const id = perProject.value.get(key);
    if (!id) return false;
  }
  return true;
});

const projectsMissingCategory = computed(() => {
  if (!category.value) return [] as string[];
  const out: string[] = [];
  for (const key of props.projectKeys) {
    const grouped = statusesByProject.value.get(key);
    if (!grouped) continue;
    if (grouped[category.value].length === 0) out.push(key);
  }
  return out;
});

function pickStatus(projectKey: string, statusId: string) {
  const next = new Map(perProject.value);
  next.set(projectKey, statusId);
  perProject.value = next;
}

// ─── submit ────────────────────────────────────────────────────────────────

async function submit() {
  if (!fullyMapped.value || !category.value) return;
  submitting.value = true;
  try {
    const isClosed = category.value === "closed";
    const results = await Promise.allSettled(
      props.selectedTickets.map((t) => {
        const statusId = perProject.value.get(t.project.key);
        if (!statusId) {
          return Promise.reject(new Error(`no status mapped for project ${t.project.key}`));
        }
        const body: Record<string, unknown> = { status_id: statusId };
        if (isClosed) body.resolution = resolution.value;
        return api.POST("/v1/tickets/{idOrKey}/transition", {
          params: { path: { idOrKey: t.id } },
          body: body as never,
        });
      })
    );
    const failed = results.filter((r) => r.status === "rejected").length;
    const total = props.selectedTickets.length;
    if (failed === 0) {
      toast.success(`Moved ${total} ticket${total === 1 ? "" : "s"}`);
    } else {
      toast.error(`Moved ${total - failed}/${total}; ${failed} failed`);
    }
    qc.invalidateQueries({ queryKey: ["sw", "tickets"] });
    qc.invalidateQueries({ queryKey: ["sw", "projects"] });
    qc.invalidateQueries({ queryKey: ["sw", "boards"] });
    qc.invalidateQueries({ queryKey: ["sw", "stats"] });
    emit("done");
    emit("update:open", false);
  } finally {
    submitting.value = false;
  }
}

function projectMappingRow(projectKey: string) {
  const grouped = statusesByProject.value.get(projectKey);
  if (!grouped || !category.value) return { kind: "loading" as const };
  const inCat = grouped[category.value];
  if (inCat.length === 0) return { kind: "missing" as const };
  if (inCat.length === 1) return { kind: "single" as const, status: inCat[0]! };
  return { kind: "multi" as const, statuses: inCat };
}
</script>

<template>
  <Dialog :open="open" @update:open="(v) => emit('update:open', v)">
    <DialogContent class="sm:max-w-lg">
      <DialogHeader>
        <DialogTitle>Move to status</DialogTitle>
        <DialogDescription>
          Picking a category sets every selected ticket to the matching status
          in its own project. When a project has multiple statuses in that
          category, you'll get a dropdown for it.
        </DialogDescription>
      </DialogHeader>

      <div class="space-y-4">
        <!-- Step 1: pick category -->
        <div class="space-y-1.5">
          <Label class="text-xs uppercase tracking-wider text-muted-foreground">
            Status category
          </Label>
          <div class="flex flex-wrap gap-1.5">
            <button
              v-for="c in CATEGORIES"
              :key="c.value"
              type="button"
              :class="cn(
                'rounded-md border px-3 py-1.5 text-sm transition-colors',
                category === c.value
                  ? 'border-primary bg-accent/50 text-foreground'
                  : 'border-border text-muted-foreground hover:bg-accent/40 hover:text-foreground'
              )"
              @click="category = c.value"
            >
              {{ c.label }}
            </button>
          </div>
        </div>

        <!-- Step 2: per-project mapping -->
        <div v-if="category" class="space-y-1.5">
          <Label class="text-xs uppercase tracking-wider text-muted-foreground">
            Mapping
          </Label>
          <div v-if="!allLoaded" class="text-xs text-muted-foreground italic flex items-center gap-2">
            <Loader2 class="h-3.5 w-3.5 animate-spin" /> Loading project statuses…
          </div>
          <ul v-else class="space-y-1.5">
            <li
              v-for="key in projectKeys"
              :key="key"
              class="flex items-center gap-2 text-sm"
            >
              <span class="font-mono text-xs text-muted-foreground w-20 shrink-0">{{ key }}</span>
              <MoveRight class="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              <template v-if="projectMappingRow(key).kind === 'single'">
                <span class="flex-1 truncate">
                  {{ (projectMappingRow(key) as any).status.display_name }}
                </span>
              </template>
              <Select
                v-else-if="projectMappingRow(key).kind === 'multi'"
                :model-value="perProject.get(key) ?? ''"
                @update:model-value="(v) => pickStatus(key, String(v))"
              >
                <SelectTrigger class="h-8 flex-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem
                    v-for="s in (projectMappingRow(key) as any).statuses"
                    :key="s.id"
                    :value="s.id"
                  >
                    {{ s.display_name }}
                  </SelectItem>
                </SelectContent>
              </Select>
              <span
                v-else-if="projectMappingRow(key).kind === 'missing'"
                class="flex-1 text-xs italic text-rose-600 dark:text-rose-500"
              >
                Project has no status in this category — skip or add one in settings.
              </span>
              <span v-else class="flex-1 text-xs text-muted-foreground italic">…</span>
            </li>
          </ul>
        </div>

        <!-- Resolution required when category=closed -->
        <div v-if="category === 'closed'" class="space-y-1.5">
          <Label class="text-xs uppercase tracking-wider text-muted-foreground">
            Resolution
          </Label>
          <div class="flex gap-1.5">
            <button
              v-for="r in (['done','released','cancelled'] as const)"
              :key="r"
              type="button"
              :class="cn(
                'rounded-md border px-3 py-1 text-sm transition-colors capitalize',
                resolution === r
                  ? 'border-primary bg-accent/50 text-foreground'
                  : 'border-border text-muted-foreground hover:bg-accent/40 hover:text-foreground'
              )"
              @click="resolution = r"
            >
              {{ r }}
            </button>
          </div>
        </div>

        <p
          v-if="projectsMissingCategory.length > 0"
          class="text-xs text-rose-600 dark:text-rose-500"
        >
          ⚠ {{ projectsMissingCategory.length }} project(s) don't have a status in this category. Their tickets won't move.
        </p>
      </div>

      <DialogFooter>
        <Button variant="ghost" @click="emit('update:open', false)">Cancel</Button>
        <Button
          :disabled="!fullyMapped || submitting"
          @click="submit"
        >
          <Loader2 v-if="submitting" class="h-3.5 w-3.5 mr-1.5 animate-spin" />
          Move {{ selectedTickets.length }} ticket{{ selectedTickets.length === 1 ? "" : "s" }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
