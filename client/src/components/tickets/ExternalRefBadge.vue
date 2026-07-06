<script setup lang="ts">
import { computed } from "vue";
import {
  GitPullRequest, GitPullRequestClosed, GitMerge, CircleDot, GitCommitHorizontal,
  Play, CheckCircle2, XCircle, Link2,
} from "lucide-vue-next";
import type { ExternalRef } from "@switchyard/shared";
import { cn } from "@/lib/utils";

// `ref` is reserved by Vue (template-ref binding) and cannot be used
// as a prop name — `value` keeps the call sites compact.
const props = defineProps<{
  value: ExternalRef;
  size?: "xs" | "sm";
}>();

// Tone per (kind, state) — keeps the badge visually meaningful at a
// glance even without the tooltip.
// v4 family: landed work (merged PR / closed issue / green build) is
// closed-green, in-flight is progress-blue, failed/dead is blocked-red.
const tone = computed(() => {
  const { kind, state } = props.value;
  if (kind === "github_pr") {
    if (state === "merged") return "text-st-closed";
    if (state === "closed") return "text-neg";
    return "text-st-progress"; // open or null
  }
  if (kind === "github_issue") {
    return state === "closed" ? "text-st-closed" : "text-st-progress";
  }
  if (kind === "github_action") {
    if (state === "success") return "text-pos";
    if (state === "failed") return "text-neg";
    return "text-muted-foreground"; // running
  }
  return "text-muted-foreground";
});

// Icon per (kind, state).
const icon = computed(() => {
  const { kind, state } = props.value;
  if (kind === "github_pr") {
    if (state === "merged") return GitMerge;
    if (state === "closed") return GitPullRequestClosed;
    return GitPullRequest;
  }
  if (kind === "github_issue") return CircleDot;
  if (kind === "github_commit") return GitCommitHorizontal;
  if (kind === "github_action") {
    if (state === "success") return CheckCircle2;
    if (state === "failed") return XCircle;
    return Play;
  }
  return Link2;
});

const tooltip = computed(() => {
  const { kind, state, title, url } = props.value;
  const stateLabel = state ? ` (${state})` : "";
  const kindLabel = kind.replace(/^github_/, "");
  const titlePart = title ? ` — ${title}` : "";
  return `${kindLabel}${stateLabel}${titlePart}\n${url}`;
});

const dim = computed(() => props.size === "xs" ? "h-3 w-3" : "h-3.5 w-3.5");
</script>

<template>
  <a
    :href="value.url"
    target="_blank"
    rel="noopener noreferrer"
    :title="tooltip"
    :class="cn('inline-flex items-center hover:opacity-80 transition-opacity', tone)"
    @click.stop
  >
    <component :is="icon" :class="dim" />
  </a>
</template>
