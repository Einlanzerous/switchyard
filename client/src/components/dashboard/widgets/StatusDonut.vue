<script setup lang="ts">
// Donut chart of current ticket counts by status category. Powered by the
// existing project-stats endpoint when scoped to a single project, or by
// summing per-project rows from /v1/stats/projects when global.

import { computed } from "vue";
import { useQuery } from "@tanstack/vue-query";
import { api } from "@/lib/api";
import { queryKeys } from "@/lib/queryKeys";
import { useProjectStats } from "@/composables/useProjectStats";
import { STATUS_HEX } from "@/lib/statusColors";
import Chart from "@/components/charts/Chart.vue";

const props = defineProps<{
  // When set, scope to one project. When omitted, sum across all projects.
  projectKey?: string;
}>();

const projectKeyComp = computed(() => props.projectKey ?? null);
const single = useProjectStats(projectKeyComp);

const bulk = useQuery({
  queryKey: queryKeys.statsProjects(),
  enabled: computed(() => !props.projectKey),
  staleTime: 60 * 1000,
  queryFn: async () => {
    const { data, error } = await api.GET("/v1/stats/projects");
    if (error) throw error;
    return data;
  },
});

const counts = computed(() => {
  if (props.projectKey) {
    return single.data.value?.by_category ?? null;
  }
  const items = bulk.data.value?.items ?? [];
  if (items.length === 0) return null;
  return items.reduce(
    (acc, r) => ({
      backlog: acc.backlog + r.by_category.backlog,
      planning: acc.planning + r.by_category.planning,
      in_progress: acc.in_progress + r.by_category.in_progress,
      blocked: acc.blocked + r.by_category.blocked,
      closed: acc.closed + r.by_category.closed,
    }),
    { backlog: 0, planning: 0, in_progress: 0, blocked: 0, closed: 0 }
  );
});

const isEmpty = computed(() => {
  const c = counts.value;
  return !c || (c.backlog + c.planning + c.in_progress + c.blocked + c.closed) === 0;
});

const option = computed(() => {
  const c = counts.value ?? {
    backlog: 0, planning: 0, in_progress: 0, blocked: 0, closed: 0,
  };
  return {
    tooltip: { trigger: "item" },
    legend: { bottom: 0, type: "scroll", icon: "circle", itemHeight: 8 },
    series: [{
      type: "pie",
      radius: ["55%", "75%"],
      center: ["50%", "44%"],
      avoidLabelOverlap: true,
      label: { show: false },
      data: [
        { name: "Backlog", value: c.backlog, itemStyle: { color: STATUS_HEX.backlog } },
        { name: "Planning", value: c.planning, itemStyle: { color: STATUS_HEX.planning } },
        { name: "In Progress", value: c.in_progress, itemStyle: { color: STATUS_HEX.in_progress } },
        { name: "Blocked", value: c.blocked, itemStyle: { color: STATUS_HEX.blocked } },
        { name: "Closed", value: c.closed, itemStyle: { color: STATUS_HEX.closed } },
      ].filter((d) => d.value > 0),
    }],
  };
});
</script>

<template>
  <Chart
    :option="option"
    :empty="isEmpty"
    :loading="single.isLoading.value || bulk.isLoading.value"
    height="220px"
  />
</template>
