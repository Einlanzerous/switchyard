<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { RouterLink } from "vue-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/vue-query";
import {
  Plus, Loader2, Trash2, Pencil, Workflow, Copy, AlertTriangle, ChevronRight,
  Power, PowerOff, Code,
} from "lucide-vue-next";
import { toast } from "vue-sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import EmptyState from "@/components/EmptyState.vue";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { api } from "@/lib/api";
import { queryKeys } from "@/lib/queryKeys";
import {
  Rule as RuleSchema,
  RuleConditions, RuleAction,
  ScheduledRuleTarget,
  type EventType, type Rule, type RuleConditionOp,
} from "@switchyard/shared";

const qc = useQueryClient();

const rulesQuery = useQuery({
  queryKey: queryKeys.rules(),
  queryFn: async () => {
    const { data, error } = await api.GET("/v1/rules", { params: { query: { limit: 200 } } });
    if (error) throw error;
    return data;
  },
});
const items = computed(() => rulesQuery.data.value?.items ?? []);

const projectsQuery = useQuery({
  queryKey: queryKeys.projects(),
  queryFn: async () => {
    const { data, error } = await api.GET("/v1/projects", { params: { query: { limit: 200 } } });
    if (error) throw error;
    return data;
  },
});
const projects = computed(() => projectsQuery.data.value?.items ?? []);
function projectKeyForId(id: string | null): string {
  if (!id) return "(all projects)";
  return projects.value.find((p) => p.id === id)?.key ?? "(unknown)";
}

const targetsQuery = useQuery({
  queryKey: queryKeys.targets(),
  queryFn: async () => {
    const { data, error } = await api.GET("/v1/targets", { params: { query: { limit: 200 } } });
    if (error) throw error;
    return data;
  },
});
const targetNames = computed(() => targetsQuery.data.value?.items.map((t) => t.name) ?? []);

const ALL_EVENTS: EventType[] = [
  "ticket.created", "ticket.updated", "ticket.status_changed", "ticket.assigned",
  "ticket.closed", "ticket.released", "ticket.deleted",
  "comment.created", "comment.updated", "comment.deleted",
  "attachment.added", "attachment.removed",
  "project.created", "project.updated", "project.deleted",
];

const OPS: RuleConditionOp[] = ["eq", "ne", "in", "not_in", "contains", "is_null", "is_not_null"];
const CATEGORIES = ["backlog", "planning", "in_progress", "blocked", "closed"] as const;
const ACTION_TYPES = [
  "set_field", "add_label", "comment", "assign", "move_status", "fire_webhook", "call_n8n",
] as const;
type ActionType = typeof ACTION_TYPES[number];

// ─── dialog state ───────────────────────────────────────────────────────────
const dialogOpen = ref(false);
const editing = ref<Rule | null>(null);
const fresh = ref<{ name: string; secret: string } | null>(null);

const draftName = ref("");
const draftEnabled = ref(true);
const draftProjectId = ref<string | "">("");
const draftMode = ref<"event" | "scheduled">("event");
const draftEvents = ref<Set<string>>(new Set());

// scheduled fields
const draftCron = ref("");
const draftTz = ref("UTC");
const draftTargetQueryJson = ref("{}");

// conditions: visual + JSON modes
const condJsonMode = ref(false);
const condJsonText = ref("{}");
const condCombinator = ref<"all" | "any">("all");
const condLeaves = ref<Array<{ field: string; op: RuleConditionOp; value: string }>>([]);

// actions: array of {type, fields} draft entries
type DraftAction =
  | { type: "set_field"; field: string; value: string }
  | { type: "add_label"; label: string; color?: string }
  | { type: "comment"; body: string }
  | { type: "assign"; user: string | null }
  | { type: "move_status"; to_category: typeof CATEGORIES[number]; to_status?: string; resolution?: string }
  | { type: "fire_webhook"; mode: "url" | "target"; url?: string; target?: string; path?: string }
  | { type: "call_n8n"; workflow: string };
const draftActions = ref<DraftAction[]>([]);

watch(dialogOpen, (v) => {
  if (!v) {
    editing.value = null;
    fresh.value = null;
  }
});

function resetDraft() {
  draftName.value = "";
  draftEnabled.value = true;
  draftProjectId.value = "";
  draftMode.value = "event";
  draftEvents.value = new Set();
  draftCron.value = "";
  draftTz.value = "UTC";
  draftTargetQueryJson.value = "{}";
  condJsonMode.value = false;
  condJsonText.value = "{}";
  condCombinator.value = "all";
  condLeaves.value = [];
  draftActions.value = [];
}

function openCreate() {
  resetDraft();
  fresh.value = null;
  dialogOpen.value = true;
}

function openEdit(r: Rule) {
  resetDraft();
  editing.value = r;
  draftName.value = r.name;
  draftEnabled.value = r.enabled;
  draftProjectId.value = r.project_id ?? "";
  if (r.schedule_cron) {
    draftMode.value = "scheduled";
    draftCron.value = r.schedule_cron;
    draftTz.value = r.schedule_tz ?? "UTC";
    draftTargetQueryJson.value = JSON.stringify(r.target_query ?? {}, null, 2);
  } else {
    draftMode.value = "event";
    draftEvents.value = new Set(r.trigger_event_types as string[]);
  }
  // Conditions: try to render visually, otherwise fall through to JSON mode.
  const c = r.conditions as Record<string, unknown>;
  if (c && typeof c === "object" && !Array.isArray(c)) {
    const allArr = Array.isArray(c.all) ? c.all : null;
    const anyArr = Array.isArray(c.any) ? c.any : null;
    const arr = allArr ?? anyArr;
    const isFlat = arr && arr.every((x) => x && typeof x === "object" && "field" in x);
    if (isFlat && arr) {
      condCombinator.value = allArr ? "all" : "any";
      condLeaves.value = arr.map((x: any) => ({
        field: x.field,
        op: x.op,
        value: x.value === undefined ? "" : JSON.stringify(x.value),
      }));
    } else {
      condJsonMode.value = true;
      condJsonText.value = JSON.stringify(c, null, 2);
    }
  }
  // Actions: hydrate visual editors. Unknown / nested shapes fall through
  // to a json string in their entry (rare; flag via "Use JSON" toggle later).
  draftActions.value = (r.actions ?? []).map(actionToDraft);
  fresh.value = null;
  dialogOpen.value = true;
}

function actionToDraft(a: any): DraftAction {
  switch (a.type) {
    case "set_field":
      return { type: "set_field", field: a.field, value: a.value === null ? "null" : JSON.stringify(a.value) };
    case "add_label":
      return { type: "add_label", label: a.label, color: a.color };
    case "comment":
      return { type: "comment", body: a.body };
    case "assign":
      return { type: "assign", user: a.user };
    case "move_status":
      return { type: "move_status", to_category: a.to_category, to_status: a.to_status, resolution: a.resolution };
    case "fire_webhook":
      return {
        type: "fire_webhook",
        mode: a.target ? "target" : "url",
        url: a.url,
        target: a.target,
        path: a.path,
      };
    case "call_n8n":
      return { type: "call_n8n", workflow: a.workflow };
    default:
      // Unknown action type — represent as set_field stub so the editor doesn't crash.
      return { type: "set_field", field: "metadata.unknown", value: JSON.stringify(a) };
  }
}

function toggleEvent(e: string) {
  const next = new Set(draftEvents.value);
  if (next.has(e)) next.delete(e);
  else next.add(e);
  draftEvents.value = next;
}

function addLeaf() {
  condLeaves.value = [...condLeaves.value, { field: "ticket.priority", op: "eq", value: '"high"' }];
}
function removeLeaf(i: number) {
  condLeaves.value = condLeaves.value.filter((_, idx) => idx !== i);
}

function addAction(type: ActionType) {
  const defaults: Record<ActionType, DraftAction> = {
    set_field: { type: "set_field", field: "priority", value: '"high"' },
    add_label: { type: "add_label", label: "" },
    comment: { type: "comment", body: "" },
    assign: { type: "assign", user: "" },
    move_status: { type: "move_status", to_category: "closed", resolution: "done" },
    fire_webhook: { type: "fire_webhook", mode: targetNames.value.length > 0 ? "target" : "url" },
    call_n8n: { type: "call_n8n", workflow: "" },
  };
  draftActions.value = [...draftActions.value, defaults[type]];
}
function removeAction(i: number) {
  draftActions.value = draftActions.value.filter((_, idx) => idx !== i);
}

// ─── build payload ──────────────────────────────────────────────────────────

function buildConditions(): unknown {
  if (condJsonMode.value) {
    const txt = condJsonText.value.trim();
    if (!txt) return {};
    const parsed = JSON.parse(txt); // throws → caught by save
    return parsed;
  }
  if (condLeaves.value.length === 0) return {};
  const leaves = condLeaves.value.map((l) => {
    const out: any = { field: l.field, op: l.op };
    // is_null / is_not_null don't need a value.
    if (l.op !== "is_null" && l.op !== "is_not_null") {
      out.value = l.value === "" ? "" : JSON.parse(l.value);
    }
    return out;
  });
  return { [condCombinator.value]: leaves };
}

function buildActions(): unknown[] {
  return draftActions.value.map((a): any => {
    switch (a.type) {
      case "set_field": {
        const value = a.value === "" ? null : JSON.parse(a.value);
        return { type: "set_field", field: a.field, value };
      }
      case "add_label":
        return { type: "add_label", label: a.label, ...(a.color ? { color: a.color } : {}) };
      case "comment":
        return { type: "comment", body: a.body };
      case "assign":
        return { type: "assign", user: a.user === "" ? null : a.user };
      case "move_status":
        return {
          type: "move_status",
          to_category: a.to_category,
          ...(a.to_status ? { to_status: a.to_status } : {}),
          ...(a.resolution ? { resolution: a.resolution } : {}),
        };
      case "fire_webhook":
        if (a.mode === "target") {
          return { type: "fire_webhook", target: a.target, ...(a.path ? { path: a.path } : {}) };
        }
        return { type: "fire_webhook", url: a.url };
      case "call_n8n":
        return { type: "call_n8n", workflow: a.workflow };
    }
  });
}

function buildPayload() {
  const conditions = buildConditions();
  const actions = buildActions();
  // Run through shared Zod so the API doesn't 400 on shape mistakes.
  // Cast to `any` past validation: the openapi-fetch body type infers a
  // stricter shape than the Zod parse output, and JSON.parse of user input
  // returns `unknown`. The runtime check is the source of truth.
  const parsedActions = RuleAction.array().parse(actions) as any;
  const parsedConditions = RuleConditions.parse(conditions) as any;

  const base: any = {
    project_id: draftProjectId.value || null,
    name: draftName.value.trim(),
    enabled: draftEnabled.value,
    conditions: parsedConditions,
    actions: parsedActions,
  };
  if (draftMode.value === "event") {
    base.trigger_event_types = Array.from(draftEvents.value);
  } else {
    base.trigger_event_types = [];
    base.schedule_cron = draftCron.value.trim();
    if (draftTz.value.trim()) base.schedule_tz = draftTz.value.trim();
    const tqTxt = draftTargetQueryJson.value.trim();
    if (tqTxt) {
      const tq = JSON.parse(tqTxt);
      base.target_query = ScheduledRuleTarget.parse(tq);
    }
  }
  return base;
}

const saveMutation = useMutation({
  mutationFn: async () => {
    let payload: any;
    try {
      payload = buildPayload();
    } catch (err) {
      throw new Error((err as Error).message ?? "invalid input");
    }
    if (editing.value) {
      // Editor doesn't allow project_id changes (immutable like project key).
      const { project_id, ...rest } = payload;
      void project_id;
      const { data, error } = await api.PATCH("/v1/rules/{id}", {
        params: { path: { id: editing.value.id } },
        body: rest,
      });
      if (error) throw error;
      return { kind: "updated" as const, data };
    }
    const { data, error } = await api.POST("/v1/rules", { body: payload });
    if (error) throw error;
    return { kind: "created" as const, data };
  },
  onSuccess: (result) => {
    qc.invalidateQueries({ queryKey: queryKeys.rules() });
    if (result.kind === "created" && result.data?.webhook_secret) {
      fresh.value = { name: result.data.name, secret: result.data.webhook_secret };
    } else {
      toast.success("Rule updated");
      dialogOpen.value = false;
    }
  },
  onError: (err: Error) => {
    toast.error(err.message ?? "Save failed");
  },
});

const togglingId = ref<string | null>(null);
const toggleMutation = useMutation({
  mutationFn: async (r: Rule) => {
    togglingId.value = r.id;
    const { error } = await api.PATCH("/v1/rules/{id}", {
      params: { path: { id: r.id } },
      body: { enabled: !r.enabled },
    });
    if (error) throw error;
  },
  onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.rules() }),
  onSettled: () => { togglingId.value = null; },
});

const deletingId = ref<string | null>(null);
const deleteMutation = useMutation({
  mutationFn: async (id: string) => {
    deletingId.value = id;
    const { error } = await api.DELETE("/v1/rules/{id}", { params: { path: { id } } });
    if (error) throw error;
  },
  onSuccess: () => {
    qc.invalidateQueries({ queryKey: queryKeys.rules() });
    toast.success("Rule deleted");
  },
  onSettled: () => { deletingId.value = null; },
});

async function copySecret() {
  if (!fresh.value) return;
  try {
    await navigator.clipboard.writeText(fresh.value.secret);
    toast.success("Secret copied");
  } catch {
    toast.error("Couldn't copy — select and copy manually");
  }
}

function triggerSummary(r: Rule): string {
  if (r.schedule_cron) return `cron "${r.schedule_cron}"${r.schedule_tz && r.schedule_tz !== "UTC" ? " " + r.schedule_tz : ""}`;
  return r.trigger_event_types.join(", ") || "—";
}

const canSave = computed(() => {
  if (draftName.value.trim().length === 0) return false;
  if (draftActions.value.length === 0) return false;
  if (draftMode.value === "event" && draftEvents.value.size === 0) return false;
  if (draftMode.value === "scheduled" && draftCron.value.trim().length === 0) return false;
  return true;
});
void RuleSchema; // exported but unused at runtime — keeps the import honest for future visual extensions
</script>

<template>
  <div class="space-y-4">
    <header class="flex items-end justify-between gap-3">
      <div>
        <h2 class="text-xl font-semibold tracking-tight">Rules</h2>
        <p class="text-sm text-muted-foreground">
          React to ticket events or run on a schedule. Actions run as
          <code class="text-xs">rules-engine</code> so audit history shows the cause.
        </p>
      </div>
      <Button size="sm" @click="openCreate">
        <Plus class="h-3.5 w-3.5 mr-1.5" /> New rule
      </Button>
    </header>

    <Card>
      <CardContent class="p-0">
        <div v-if="rulesQuery.isLoading.value" class="p-4 space-y-2">
          <Skeleton v-for="n in 3" :key="n" class="h-14 w-full" />
        </div>
        <ul v-else-if="items.length > 0" class="divide-y">
          <li v-for="r in items" :key="r.id" class="flex items-start gap-3 p-3">
            <Workflow class="h-4 w-4 text-muted-foreground shrink-0 mt-1" />
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-2">
                <span class="font-medium text-sm">{{ r.name }}</span>
                <Badge v-if="!r.enabled" variant="secondary" class="text-[10px]">paused</Badge>
                <span class="text-xs text-muted-foreground font-mono">{{ projectKeyForId(r.project_id) }}</span>
              </div>
              <div class="text-xs text-muted-foreground mt-0.5 font-mono truncate">
                {{ triggerSummary(r as Rule) }}
              </div>
            </div>
            <RouterLink
              :to="`/automations/rules/${r.id}/firings`"
              class="text-xs text-muted-foreground hover:text-foreground inline-flex items-center self-center"
            >
              Firings <ChevronRight class="h-3 w-3 ml-0.5" />
            </RouterLink>
            <Button
              variant="ghost"
              size="sm"
              :disabled="togglingId === r.id"
              :title="r.enabled ? 'Pause' : 'Resume'"
              @click="toggleMutation.mutate(r as Rule)"
            >
              <Loader2 v-if="togglingId === r.id" class="h-3.5 w-3.5 animate-spin" />
              <component :is="r.enabled ? Power : PowerOff" v-else class="h-3.5 w-3.5" />
            </Button>
            <Button variant="ghost" size="sm" @click="openEdit(r as Rule)">
              <Pencil class="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              class="text-muted-foreground hover:text-destructive"
              :disabled="deletingId === r.id"
              @click="deleteMutation.mutate(r.id)"
            >
              <Loader2 v-if="deletingId === r.id" class="h-3.5 w-3.5 animate-spin" />
              <Trash2 v-else class="h-3.5 w-3.5" />
            </Button>
          </li>
        </ul>
        <EmptyState
          v-else
          :icon="Workflow"
          title="No rules yet"
          description="Rules react to ticket events or run on a schedule. Try: when a high-priority bug is created, post a comment to claude."
        >
          <template #action>
            <Button size="sm" @click="openCreate">
              <Plus class="h-3.5 w-3.5 mr-1.5" /> New rule
            </Button>
          </template>
        </EmptyState>
      </CardContent>
    </Card>

    <!-- Create / edit dialog -->
    <Dialog v-model:open="dialogOpen">
      <DialogContent class="sm:max-w-3xl max-h-[90vh] overflow-y-auto">
        <template v-if="!fresh">
          <DialogHeader>
            <DialogTitle>{{ editing ? "Edit rule" : "New rule" }}</DialogTitle>
            <DialogDescription>
              Choose a trigger, set conditions on the event payload, and define the
              actions that run when matched.
            </DialogDescription>
          </DialogHeader>

          <!-- Header fields -->
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div class="space-y-1.5 sm:col-span-2">
              <Label for="rule-name">Name</Label>
              <Input id="rule-name" v-model="draftName" placeholder="auto-triage on creation" autofocus />
            </div>
            <div class="space-y-1.5">
              <Label for="rule-project">Project</Label>
              <select
                id="rule-project"
                v-model="draftProjectId"
                :disabled="!!editing"
                class="w-full rounded-md border bg-background px-2 py-1.5 text-sm"
              >
                <option value="">All projects (global)</option>
                <option v-for="p in projects" :key="p.id" :value="p.id">{{ p.key }} — {{ p.name }}</option>
              </select>
            </div>
            <div class="space-y-1.5 flex items-end">
              <label class="flex items-center gap-2 text-sm cursor-pointer">
                <Checkbox v-model="draftEnabled" />
                Enabled
              </label>
            </div>
          </div>

          <!-- Trigger mode -->
          <div class="space-y-2 pt-2">
            <Label>Trigger</Label>
            <div class="flex items-center gap-4 text-sm">
              <label class="flex items-center gap-1.5 cursor-pointer">
                <input type="radio" v-model="draftMode" value="event" /> Event-triggered
              </label>
              <label class="flex items-center gap-1.5 cursor-pointer">
                <input type="radio" v-model="draftMode" value="scheduled" /> Scheduled (cron)
              </label>
            </div>

            <!-- Event picker -->
            <div v-if="draftMode === 'event'" class="rounded-md border max-h-48 overflow-auto divide-y">
              <label
                v-for="e in ALL_EVENTS"
                :key="e"
                class="flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-accent/40 cursor-pointer"
                @click.prevent="toggleEvent(e)"
              >
                <Checkbox :model-value="draftEvents.has(e)" @click.stop="toggleEvent(e)" />
                <span class="font-mono text-xs">{{ e }}</span>
              </label>
            </div>

            <!-- Scheduled fields -->
            <div v-else class="space-y-3">
              <div class="grid grid-cols-2 gap-3">
                <div class="space-y-1.5">
                  <Label for="rule-cron">Cron expression</Label>
                  <Input id="rule-cron" v-model="draftCron" placeholder="0 9 * * MON" class="font-mono" />
                </div>
                <div class="space-y-1.5">
                  <Label for="rule-tz">Timezone (IANA)</Label>
                  <Input id="rule-tz" v-model="draftTz" placeholder="UTC" class="font-mono" />
                </div>
              </div>
              <div class="space-y-1.5">
                <Label for="rule-tq">Target query (JSON)</Label>
                <textarea
                  id="rule-tq"
                  v-model="draftTargetQueryJson"
                  rows="4"
                  class="w-full rounded-md border bg-background px-3 py-2 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-ring resize-y"
                  placeholder='{"status": "in_progress"}'
                />
                <p class="text-xs text-muted-foreground">
                  Subset of <code>/v1/tickets</code> filters: project, status, type, label,
                  assignee, reporter, parent_id, text, updated_after/before.
                </p>
              </div>
            </div>
          </div>

          <!-- Conditions -->
          <div class="space-y-2 pt-2">
            <div class="flex items-center justify-between">
              <Label>Conditions</Label>
              <Button
                type="button" variant="ghost" size="sm"
                @click="condJsonMode = !condJsonMode"
              >
                <Code class="h-3.5 w-3.5 mr-1" />
                {{ condJsonMode ? "Visual" : "JSON" }}
              </Button>
            </div>

            <textarea
              v-if="condJsonMode"
              v-model="condJsonText"
              rows="6"
              class="w-full rounded-md border bg-background px-3 py-2 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-ring resize-y"
              placeholder='{"all": [{"field": "ticket.priority", "op": "eq", "value": "high"}]}'
            />

            <div v-else class="space-y-2">
              <div v-if="condLeaves.length === 0" class="text-xs text-muted-foreground italic">
                No conditions — rule fires for every matching event.
              </div>
              <div v-else class="flex items-center gap-2 text-sm">
                <span class="text-muted-foreground">Match</span>
                <select
                  v-model="condCombinator"
                  class="rounded border bg-background px-2 py-0.5 text-xs"
                >
                  <option value="all">all of</option>
                  <option value="any">any of</option>
                </select>
                <span class="text-muted-foreground">the following:</span>
              </div>
              <ul class="space-y-1.5">
                <li
                  v-for="(leaf, i) in condLeaves"
                  :key="i"
                  class="grid grid-cols-[1fr_auto_1fr_auto] gap-2 items-center"
                >
                  <Input v-model="leaf.field" placeholder="ticket.priority" class="font-mono text-xs" />
                  <select
                    v-model="leaf.op"
                    class="rounded border bg-background px-2 py-1.5 text-xs"
                  >
                    <option v-for="o in OPS" :key="o" :value="o">{{ o }}</option>
                  </select>
                  <Input
                    v-model="leaf.value"
                    :disabled="leaf.op === 'is_null' || leaf.op === 'is_not_null'"
                    placeholder='"high" or ["high","critical"]'
                    class="font-mono text-xs"
                  />
                  <Button variant="ghost" size="sm" @click="removeLeaf(i)">
                    <Trash2 class="h-3.5 w-3.5" />
                  </Button>
                </li>
              </ul>
              <Button type="button" variant="ghost" size="sm" @click="addLeaf">
                <Plus class="h-3.5 w-3.5 mr-1" /> Add condition
              </Button>
            </div>
          </div>

          <!-- Actions -->
          <div class="space-y-2 pt-2">
            <Label>Actions</Label>
            <div v-if="draftActions.length === 0" class="text-xs text-muted-foreground italic">
              At least one action required.
            </div>
            <ul class="space-y-2">
              <li
                v-for="(action, i) in draftActions"
                :key="i"
                class="rounded-md border p-3 space-y-2"
              >
                <div class="flex items-center justify-between">
                  <Badge variant="secondary" class="text-[10px] font-mono">{{ action.type }}</Badge>
                  <Button variant="ghost" size="sm" @click="removeAction(i)">
                    <Trash2 class="h-3.5 w-3.5" />
                  </Button>
                </div>

                <!-- set_field -->
                <div v-if="action.type === 'set_field'" class="grid grid-cols-2 gap-2">
                  <Input v-model="action.field" placeholder="priority" class="font-mono text-xs" />
                  <Input v-model="action.value" placeholder='"high"' class="font-mono text-xs" />
                </div>

                <!-- add_label -->
                <div v-else-if="action.type === 'add_label'" class="grid grid-cols-2 gap-2">
                  <Input v-model="action.label" placeholder="auto-triage" class="font-mono text-xs" />
                  <Input v-model="action.color" placeholder="#6b7280" class="font-mono text-xs" />
                </div>

                <!-- comment -->
                <textarea
                  v-else-if="action.type === 'comment'"
                  v-model="action.body"
                  rows="2"
                  placeholder="Auto-closed by {{rule.name}}"
                  class="w-full rounded-md border bg-background px-3 py-2 text-xs focus:outline-none focus:ring-1 focus:ring-ring resize-y"
                />

                <!-- assign -->
                <div v-else-if="action.type === 'assign'">
                  <Input
                    :model-value="action.user ?? ''"
                    @update:model-value="(v) => (action as any).user = (v === '' ? null : v)"
                    placeholder="username or uuid; blank = unassign"
                    class="font-mono text-xs"
                  />
                </div>

                <!-- move_status -->
                <div v-else-if="action.type === 'move_status'" class="grid grid-cols-3 gap-2">
                  <select v-model="action.to_category" class="rounded border bg-background px-2 py-1.5 text-xs">
                    <option v-for="c in CATEGORIES" :key="c" :value="c">{{ c }}</option>
                  </select>
                  <Input v-model="action.to_status" placeholder="(optional) display name" class="text-xs" />
                  <select v-model="action.resolution" class="rounded border bg-background px-2 py-1.5 text-xs">
                    <option value="">(none)</option>
                    <option value="done">done</option>
                    <option value="released">released</option>
                    <option value="cancelled">cancelled</option>
                  </select>
                </div>

                <!-- fire_webhook -->
                <div v-else-if="action.type === 'fire_webhook'" class="space-y-2">
                  <div class="flex items-center gap-3 text-xs">
                    <label class="flex items-center gap-1.5 cursor-pointer">
                      <input type="radio" v-model="action.mode" value="target" /> Named target
                    </label>
                    <label class="flex items-center gap-1.5 cursor-pointer">
                      <input type="radio" v-model="action.mode" value="url" /> Literal URL
                    </label>
                  </div>
                  <div v-if="action.mode === 'target'" class="grid grid-cols-2 gap-2">
                    <select v-model="action.target" class="rounded border bg-background px-2 py-1.5 text-xs">
                      <option value="">— pick a target —</option>
                      <option v-for="n in targetNames" :key="n" :value="n">{{ n }}</option>
                    </select>
                    <Input v-model="action.path" placeholder="/webhook/foo" class="font-mono text-xs" />
                  </div>
                  <div v-else>
                    <Input v-model="action.url" placeholder="https://..." class="font-mono text-xs" />
                  </div>
                </div>

                <!-- call_n8n -->
                <Input
                  v-else-if="action.type === 'call_n8n'"
                  v-model="action.workflow"
                  placeholder="/webhook/triage-bug"
                  class="font-mono text-xs"
                />
              </li>
            </ul>
            <div class="flex flex-wrap gap-1">
              <Button
                v-for="t in ACTION_TYPES"
                :key="t"
                type="button"
                variant="outline"
                size="sm"
                @click="addAction(t)"
              >
                <Plus class="h-3 w-3 mr-1" />{{ t }}
              </Button>
            </div>
          </div>

          <DialogFooter class="pt-2">
            <Button variant="ghost" @click="dialogOpen = false">Cancel</Button>
            <Button
              :disabled="!canSave || saveMutation.isPending.value"
              @click="saveMutation.mutate()"
            >
              <Loader2 v-if="saveMutation.isPending.value" class="h-3.5 w-3.5 mr-1.5 animate-spin" />
              {{ editing ? "Save" : "Create rule" }}
            </Button>
          </DialogFooter>
        </template>

        <!-- Secret reveal screen -->
        <template v-else>
          <DialogHeader>
            <DialogTitle class="flex items-center gap-2">
              <AlertTriangle class="h-4 w-4 text-amber-500" />
              Copy the webhook secret now
            </DialogTitle>
            <DialogDescription>
              "{{ fresh.name }}" is live. The secret is used to HMAC-sign any
              <code>fire_webhook</code> / <code>call_n8n</code> action this rule
              runs. Shown ONCE — after you close this dialog only the hashed
              value remains.
            </DialogDescription>
          </DialogHeader>
          <div class="rounded-md border bg-muted/40 p-3 font-mono text-xs break-all">
            {{ fresh.secret }}
          </div>
          <DialogFooter>
            <Button variant="ghost" @click="copySecret">
              <Copy class="h-3.5 w-3.5 mr-1.5" /> Copy
            </Button>
            <Button @click="dialogOpen = false">Done</Button>
          </DialogFooter>
        </template>
      </DialogContent>
    </Dialog>
  </div>
</template>
