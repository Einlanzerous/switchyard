<script setup lang="ts">
// Automations sub-tab of the project Setup page. Shows two sections:
//   1. Rules scoped to this project (project_id matches), with edit/disable links.
//   2. Global rules also affecting this project (project_id null), read-only.
//
// New project rules are created in the global /automations/rules page;
// this sub-tab is for quick visibility + the entry point. Inline create
// is intentionally deferred — the existing global editor handles all the
// edge cases, no need to reimplement here.

import { computed } from "vue";
import { useRouter } from "vue-router";
import { useQuery } from "@tanstack/vue-query";
import { Plus, Zap, ExternalLink, Globe } from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import EmptyState from "@/components/EmptyState.vue";
import { api } from "@/lib/api";
import { queryKeys } from "@/lib/queryKeys";
import type { Rule } from "@switchyard/shared";

const props = defineProps<{ projectKey: string }>();
const router = useRouter();

// `?project=KEY` returns project-scoped rules + global rules (server union).
// We split them on the client.
const rulesQuery = useQuery({
  queryKey: computed(() => queryKeys.rules({ project: props.projectKey })),
  enabled: computed(() => props.projectKey.length > 0),
  queryFn: async () => {
    const { data, error } = await api.GET("/v1/rules", {
      params: { query: { project: props.projectKey, limit: 200 } },
    });
    if (error) throw error;
    return data;
  },
});

const projectQuery = useQuery({
  queryKey: computed(() => queryKeys.project(props.projectKey)),
  enabled: computed(() => props.projectKey.length > 0),
  queryFn: async () => {
    const { data, error } = await api.GET("/v1/projects/{key}", {
      params: { path: { key: props.projectKey } },
    });
    if (error) throw error;
    return data;
  },
});

const projectId = computed(() => projectQuery.data.value?.id ?? null);
const allRules = computed<Rule[]>(() => (rulesQuery.data.value?.items ?? []) as Rule[]);
const projectRules = computed(() =>
  projectId.value ? allRules.value.filter((r) => r.project_id === projectId.value) : [],
);
const globalRules = computed(() => allRules.value.filter((r) => r.project_id === null));

// Human-readable trigger description. Keeps the row compact while still
// surfacing the most useful info.
function triggerSummary(r: Rule): string {
  if (r.schedule_cron) return `Scheduled · ${r.schedule_cron}`;
  if (r.trigger_event_types.length === 0) return "No trigger set";
  return r.trigger_event_types.join(", ");
}

function goToRulesPage() {
  router.push("/automations/rules");
}
</script>

<template>
  <div class="px-4 py-4 space-y-6">
    <div class="flex items-center justify-between">
      <p class="text-sm text-muted-foreground">
        Rules that fire on events or schedules in this project.
        <span class="text-muted-foreground/70">
          Use the full editor for new rules — pre-scope by picking
          {{ projectKey }} in the project field.
        </span>
      </p>
      <Button size="sm" @click="goToRulesPage">
        <Plus class="h-3.5 w-3.5 mr-1.5" /> New rule
      </Button>
    </div>

    <!-- Project-scoped rules -->
    <section class="space-y-2">
      <h3 class="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        Scoped to {{ projectKey }}
      </h3>

      <div v-if="rulesQuery.isLoading.value" class="space-y-2">
        <Skeleton v-for="n in 2" :key="n" class="h-14 w-full" />
      </div>

      <EmptyState
        v-else-if="projectRules.length === 0"
        :icon="Zap"
        title="No project-scoped rules yet"
        description="Project rules only fire on events from this project. Hop to the full editor to create one."
      >
        <Button size="sm" @click="goToRulesPage">
          <Plus class="h-3.5 w-3.5 mr-1.5" /> New rule
        </Button>
      </EmptyState>

      <Card v-else>
        <CardContent class="p-0">
          <ul class="divide-y">
            <li
              v-for="r in projectRules"
              :key="r.id"
              class="flex items-center gap-3 p-3"
            >
              <Zap class="h-4 w-4 text-muted-foreground shrink-0" />
              <div class="flex-1 min-w-0">
                <div class="flex items-center gap-2 flex-wrap">
                  <span class="font-medium text-sm">{{ r.name }}</span>
                  <span
                    class="text-[10px] uppercase tracking-wider rounded px-1.5 py-0.5"
                    :class="r.enabled
                      ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
                      : 'bg-muted text-muted-foreground'"
                  >
                    {{ r.enabled ? "Enabled" : "Disabled" }}
                  </span>
                </div>
                <div class="text-xs text-muted-foreground mt-0.5 font-mono truncate" :title="triggerSummary(r)">
                  {{ triggerSummary(r) }}
                </div>
              </div>
              <Button
                variant="ghost"
                size="sm"
                class="h-8"
                title="Edit in Automations"
                @click="goToRulesPage"
              >
                <ExternalLink class="h-3.5 w-3.5" />
              </Button>
            </li>
          </ul>
        </CardContent>
      </Card>
    </section>

    <!-- Global rules also affecting this project (read-only) -->
    <section v-if="globalRules.length > 0" class="space-y-2">
      <h3 class="text-xs font-semibold uppercase tracking-wider text-muted-foreground inline-flex items-center gap-1.5">
        <Globe class="h-3 w-3" />
        Global rules also affecting this project
      </h3>
      <p class="text-[11px] text-muted-foreground/80">
        These rules run across every project. Edit them in the global Automations view.
      </p>
      <Card>
        <CardContent class="p-0">
          <ul class="divide-y">
            <li
              v-for="r in globalRules"
              :key="r.id"
              class="flex items-center gap-3 p-3"
            >
              <Globe class="h-4 w-4 text-muted-foreground shrink-0" />
              <div class="flex-1 min-w-0">
                <div class="flex items-center gap-2">
                  <span class="text-sm">{{ r.name }}</span>
                  <span
                    class="text-[10px] uppercase tracking-wider rounded px-1.5 py-0.5"
                    :class="r.enabled
                      ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
                      : 'bg-muted text-muted-foreground'"
                  >
                    {{ r.enabled ? "Enabled" : "Disabled" }}
                  </span>
                </div>
                <div class="text-[11px] text-muted-foreground mt-0.5 font-mono truncate">
                  {{ triggerSummary(r) }}
                </div>
              </div>
              <Button
                variant="ghost"
                size="sm"
                class="h-8"
                title="Open in global Automations"
                @click="goToRulesPage"
              >
                <ExternalLink class="h-3.5 w-3.5" />
              </Button>
            </li>
          </ul>
        </CardContent>
      </Card>
    </section>
  </div>
</template>
