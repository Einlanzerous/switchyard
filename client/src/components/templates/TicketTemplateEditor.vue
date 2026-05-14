<script setup lang="ts">
// Ticket template editor — used for both create and update.
//
// Two top-level modes: Recurring (cron + tz) vs One-shot (trigger date +
// lead days). Preset cron dropdown for the common cases, raw cron escape
// hatch for everything else. The server enforces XOR on the two modes via
// a CHECK constraint, so we surface that as a tab toggle here.

import { computed, ref, watch } from "vue";
import { useMutation, useQueryClient } from "@tanstack/vue-query";
import { Loader2 } from "lucide-vue-next";
import { toast } from "vue-sonner";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/api";
import { queryKeys } from "@/lib/queryKeys";
import type { TicketTemplate, OverlapPolicy, Priority, TicketType } from "@switchyard/shared";

const props = defineProps<{
  open: boolean;
  projectKey: string;
  // null = create mode; a template = edit mode.
  template: TicketTemplate | null;
}>();

const emit = defineEmits<{
  "update:open": [v: boolean];
  saved: [];
}>();

const qc = useQueryClient();

// ─── form state ──────────────────────────────────────────────────────────

type Mode = "recurring" | "one_shot";
const mode = ref<Mode>("recurring");

// Recurring presets. Custom cron unlocks the raw input.
const PRESET_OPTIONS = [
  { value: "daily",     label: "Daily at 9am" },
  { value: "weekdays",  label: "Weekdays at 9am" },
  { value: "weekly",    label: "Weekly (pick day)" },
  { value: "monthly",   label: "Monthly (pick day)" },
  { value: "custom",    label: "Advanced: custom cron" },
];
type Preset = typeof PRESET_OPTIONS[number]["value"];

const preset = ref<Preset>("weekly");
const weekday = ref(1); // 0=Sun, 1=Mon, ...
const monthDay = ref(1); // 1..28 (avoid 29-31 which not every month has)
const customCron = ref("0 9 * * MON");
// Default to browser's tz so "9am Monday" means 9am where the user is.
const tz = ref<string>(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");

// One-shot
const triggerDate = ref<string>(""); // YYYY-MM-DD
const leadDays = ref(0);

// Common template fields
const title = ref("");
const description = ref("");
const type = ref<TicketType>("task");
const priority = ref<Priority | null>(null);
const dueOffset = ref<number | null>(null);
const overlapPolicy = ref<OverlapPolicy>("skip");
const enabled = ref(true);
// Metadata for custom-field defaults — stored as raw JSON text in the
// editor for v1 simplicity. The server accepts a record<string, unknown>.
const metadataText = ref("");

// Reset / load on open.
watch(() => props.open, (open) => {
  if (!open) return;
  if (props.template) {
    // Edit mode — hydrate from existing template.
    const t = props.template;
    mode.value = t.mode;
    preset.value = "custom";
    customCron.value = t.schedule_cron ?? "0 9 * * MON";
    tz.value = t.schedule_tz ?? "UTC";
    triggerDate.value = t.trigger_at ? t.trigger_at.slice(0, 10) : "";
    leadDays.value = t.lead_days;
    title.value = t.title;
    description.value = t.description;
    type.value = t.type;
    priority.value = t.priority;
    dueOffset.value = t.due_date_offset_days;
    overlapPolicy.value = t.overlap_policy;
    enabled.value = t.enabled;
    metadataText.value = Object.keys(t.metadata).length > 0
      ? JSON.stringify(t.metadata, null, 2)
      : "";
  } else {
    // Create mode — sensible defaults.
    mode.value = "recurring";
    preset.value = "weekly";
    weekday.value = 1;
    monthDay.value = 1;
    customCron.value = "0 9 * * MON";
    tz.value = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    triggerDate.value = "";
    leadDays.value = 0;
    title.value = "";
    description.value = "";
    type.value = "task";
    priority.value = null;
    dueOffset.value = null;
    overlapPolicy.value = "skip";
    enabled.value = true;
    metadataText.value = "";
  }
});

// Resolve the preset to a cron expression on save. For "custom" we use the
// raw input as-is.
function resolveCron(): string {
  if (preset.value === "daily")    return "0 9 * * *";
  if (preset.value === "weekdays") return "0 9 * * MON-FRI";
  if (preset.value === "weekly")   return `0 9 * * ${weekday.value}`;
  if (preset.value === "monthly")  return `0 9 ${monthDay.value} * *`;
  return customCron.value;
}

// ─── save ────────────────────────────────────────────────────────────────

const saving = computed(() => createMut.isPending.value || updateMut.isPending.value);

const createMut = useMutation({
  mutationFn: async () => {
    const body = buildBody();
    const { data, error } = await api.POST("/v1/projects/{key}/templates", {
      params: { path: { key: props.projectKey } },
      body: body as never,
    });
    if (error) throw error;
    return data;
  },
});

const updateMut = useMutation({
  mutationFn: async () => {
    if (!props.template) throw new Error("update called without template");
    const body = buildBody();
    const { data, error } = await api.PATCH("/v1/templates/{id}", {
      params: { path: { id: props.template.id } },
      body: body as never,
    });
    if (error) throw error;
    return data;
  },
});

function buildBody(): Record<string, unknown> {
  // Parse metadata JSON; throw early so the mutation isn't fired with bad data.
  let metadata: Record<string, unknown> = {};
  if (metadataText.value.trim().length > 0) {
    try {
      const parsed = JSON.parse(metadataText.value);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error("metadata must be a JSON object");
      }
      metadata = parsed;
    } catch (err) {
      throw new Error(`metadata JSON: ${(err as Error).message}`);
    }
  }

  const base: Record<string, unknown> = {
    title: title.value.trim(),
    description: description.value,
    type: type.value,
    priority: priority.value,
    due_date_offset_days: dueOffset.value,
    overlap_policy: overlapPolicy.value,
    enabled: enabled.value,
    metadata,
  };

  if (mode.value === "recurring") {
    return {
      ...base,
      schedule_cron: resolveCron(),
      schedule_tz: tz.value || null,
      trigger_at: null,
      lead_days: 0,
    };
  }
  // One-shot. Convert YYYY-MM-DD to ISO at local midnight so "due 2026-08-15"
  // doesn't roll backward in UTC. The server stores it as a tz-aware ts.
  let isoTrigger: string | null = null;
  if (triggerDate.value) {
    const [y, m, d] = triggerDate.value.split("-").map(Number);
    if (y && m && d) {
      const local = new Date(y, m - 1, d, 0, 0, 0, 0);
      isoTrigger = local.toISOString();
    }
  }
  return {
    ...base,
    schedule_cron: null,
    schedule_tz: null,
    trigger_at: isoTrigger,
    lead_days: leadDays.value,
  };
}

async function save() {
  try {
    if (props.template) await updateMut.mutateAsync();
    else await createMut.mutateAsync();
    qc.invalidateQueries({ queryKey: queryKeys.ticketTemplates(props.projectKey) });
    toast.success(props.template ? "Template updated" : "Template created");
    emit("saved");
    emit("update:open", false);
  } catch (err) {
    const msg = (err as { error?: { message?: string } })?.error?.message
      ?? (err as Error).message
      ?? "Save failed";
    toast.error(msg);
  }
}

const canSave = computed(() => {
  if (title.value.trim().length === 0) return false;
  if (mode.value === "one_shot" && !triggerDate.value) return false;
  if (mode.value === "recurring" && preset.value === "custom" && !customCron.value.trim()) return false;
  return true;
});

const WEEKDAYS = [
  { value: 0, label: "Sunday" },
  { value: 1, label: "Monday" },
  { value: 2, label: "Tuesday" },
  { value: 3, label: "Wednesday" },
  { value: 4, label: "Thursday" },
  { value: 5, label: "Friday" },
  { value: 6, label: "Saturday" },
];
</script>

<template>
  <Dialog :open="open" @update:open="(v) => emit('update:open', v)">
    <DialogContent class="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
      <DialogHeader>
        <DialogTitle>{{ template ? `Edit template — ${template.title}` : "New ticket template" }}</DialogTitle>
        <DialogDescription>
          Templates materialize a ticket on schedule. Recurring runs on a cron;
          one-shot fires once at a target date.
        </DialogDescription>
      </DialogHeader>

      <div class="space-y-4 py-2">
        <!-- Mode toggle -->
        <div class="flex items-center gap-2 rounded-md border p-1">
          <button
            type="button"
            class="flex-1 h-8 rounded text-sm font-medium transition-colors"
            :class="mode === 'recurring' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'"
            @click="mode = 'recurring'"
          >Recurring</button>
          <button
            type="button"
            class="flex-1 h-8 rounded text-sm font-medium transition-colors"
            :class="mode === 'one_shot' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'"
            @click="mode = 'one_shot'"
          >One-shot</button>
        </div>

        <!-- Recurring fields -->
        <template v-if="mode === 'recurring'">
          <div class="space-y-2">
            <Label>Schedule</Label>
            <select
              v-model="preset"
              class="w-full rounded-md border bg-background px-2 py-1.5 text-sm"
            >
              <option v-for="o in PRESET_OPTIONS" :key="o.value" :value="o.value">{{ o.label }}</option>
            </select>
            <div v-if="preset === 'weekly'" class="flex items-center gap-2">
              <Label class="shrink-0 text-xs">Day of week</Label>
              <select v-model.number="weekday" class="rounded-md border bg-background px-2 py-1 text-sm">
                <option v-for="d in WEEKDAYS" :key="d.value" :value="d.value">{{ d.label }}</option>
              </select>
            </div>
            <div v-if="preset === 'monthly'" class="flex items-center gap-2">
              <Label class="shrink-0 text-xs">Day of month</Label>
              <Input v-model.number="monthDay" type="number" min="1" max="28" class="w-20" />
              <span class="text-xs text-muted-foreground">(1–28 to avoid months without 29-31)</span>
            </div>
            <div v-if="preset === 'custom'">
              <Label class="text-xs">Cron expression</Label>
              <Input v-model="customCron" placeholder="0 9 * * MON" class="font-mono text-sm" />
            </div>
          </div>
          <div>
            <Label class="text-xs">Timezone</Label>
            <Input v-model="tz" placeholder="UTC" class="font-mono text-sm" />
            <p class="text-[11px] text-muted-foreground mt-1">
              IANA tz name (e.g. America/Chicago). Defaults to your browser tz.
              The schedule is evaluated in this tz, not UTC.
            </p>
          </div>
        </template>

        <!-- One-shot fields -->
        <template v-else>
          <div>
            <Label>Trigger date</Label>
            <Input v-model="triggerDate" type="date" />
          </div>
          <div>
            <Label class="text-xs">Lead days (fire N days before)</Label>
            <Input v-model.number="leadDays" type="number" min="0" class="w-24" />
            <p class="text-[11px] text-muted-foreground mt-1">
              e.g. trigger = 2026-08-15 with lead = 7 fires on 2026-08-08.
            </p>
          </div>
        </template>

        <!-- Common template fields -->
        <div class="grid grid-cols-2 gap-3 pt-2 border-t">
          <div class="col-span-2">
            <Label>Title</Label>
            <Input v-model="title" placeholder="Weekly review" />
          </div>
          <div class="col-span-2">
            <Label class="text-xs">Description</Label>
            <textarea
              v-model="description"
              rows="3"
              class="w-full rounded-md border bg-background px-3 py-2 text-sm"
              placeholder="Optional"
            />
          </div>
          <div>
            <Label class="text-xs">Type</Label>
            <select v-model="type" class="w-full rounded-md border bg-background px-2 py-1.5 text-sm">
              <option value="task">Task</option>
              <option value="bug">Bug</option>
              <option value="spike">Spike</option>
              <option value="epic">Epic</option>
            </select>
          </div>
          <div>
            <Label class="text-xs">Priority</Label>
            <select
              :value="priority ?? ''"
              class="w-full rounded-md border bg-background px-2 py-1.5 text-sm"
              @change="(e) => priority = ((e.target as HTMLSelectElement).value || null) as Priority | null"
            >
              <option value="">No priority</option>
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
              <option value="critical">Critical</option>
            </select>
          </div>
          <div>
            <Label class="text-xs">Due date offset (days)</Label>
            <Input
              :model-value="dueOffset ?? ''"
              @update:model-value="(v) => dueOffset = v === '' ? null : Number(v)"
              type="number"
              placeholder="None"
              class="w-full"
            />
            <p class="text-[11px] text-muted-foreground mt-1">
              Each instance's due_date = fire date + this many days.
            </p>
          </div>
          <div>
            <Label class="text-xs">Overlap policy</Label>
            <select
              v-model="overlapPolicy"
              class="w-full rounded-md border bg-background px-2 py-1.5 text-sm"
            >
              <option value="skip">Skip — don't create when an open instance exists</option>
              <option value="always">Always — create regardless</option>
              <option value="reuse_open">Reuse open — bump existing instance's due date</option>
            </select>
          </div>
          <div class="col-span-2">
            <Label class="text-xs">Custom field defaults (JSON)</Label>
            <textarea
              v-model="metadataText"
              rows="3"
              class="w-full rounded-md border bg-background px-3 py-2 text-sm font-mono"
              :placeholder="`{\n  &quot;mode&quot;: &quot;greenfield&quot;\n}`"
            />
            <p class="text-[11px] text-muted-foreground mt-1">
              Optional. Copied verbatim into each instance's metadata JSONB.
            </p>
          </div>
          <div class="col-span-2 flex items-center gap-2">
            <input id="tpl-enabled" v-model="enabled" type="checkbox" class="h-4 w-4 rounded" />
            <Label for="tpl-enabled" class="cursor-pointer text-sm">Enabled</Label>
          </div>
        </div>
      </div>

      <DialogFooter>
        <Button variant="ghost" @click="emit('update:open', false)">Cancel</Button>
        <Button :disabled="!canSave || saving" @click="save">
          <Loader2 v-if="saving" class="h-3.5 w-3.5 mr-1 animate-spin" />
          {{ template ? "Save" : "Create template" }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
