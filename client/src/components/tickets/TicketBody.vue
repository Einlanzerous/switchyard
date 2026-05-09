<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { Skeleton } from "@/components/ui/skeleton";
import StatusBadge from "./StatusBadge.vue";
import TypeIcon from "./TypeIcon.vue";
import DescriptionEditor from "./DescriptionEditor.vue";
import CommentItem from "./CommentItem.vue";
import CommentComposer from "./CommentComposer.vue";
import TransitionButton from "./TransitionButton.vue";
import ActivityList from "./ActivityList.vue";
import AttachmentLink from "./AttachmentLink.vue";
import LinkedWork from "./LinkedWork.vue";
import PriorityEditor from "./PriorityEditor.vue";
import AssigneeEditor from "./AssigneeEditor.vue";
import LabelEditor from "./LabelEditor.vue";
import { cn } from "@/lib/utils";
import { useTicketDetail } from "@/composables/useTicketDetail";

// Reused by the drawer (route.query.focus) and the standalone page route
// (params.idOrKey). The parent owns the key and decides what "navigate to a
// related ticket" means in its context (drawer focus swap vs page push).
const props = withDefaults(defineProps<{
  idOrKey: string;
  // When true, suppresses the inline title block — the drawer renders the
  // ticket key + title in its own SheetTitle so we'd duplicate otherwise.
  hideTitle?: boolean;
  // Called when the user clicks a parent or sub-ticket link. Defaults to a
  // page-style push, which the drawer overrides to swap its focus param.
  onLinkNavigate?: (key: string) => void;
}>(), {
  hideTitle: false,
});

const router = useRouter();

const idOrKey = computed(() => props.idOrKey);
const {
  ticket, isLoading, allowedStatuses, events, eventsLoading, error,
  parent, parentLoading, children, childrenLoading,
} = useTicketDetail(idOrKey);

type Tab = "description" | "activity";
const activeTab = ref<Tab>("description");
watch(idOrKey, () => { activeTab.value = "description"; });

const errMessage = computed(() => {
  const e = error.value;
  if (!e) return null;
  return (e as { error?: { message?: string } }).error?.message ?? "Failed to load ticket";
});

function navigateToLinked(key: string) {
  if (props.onLinkNavigate) props.onLinkNavigate(key);
  else router.push(`/tickets/${key}`);
}

const showLinkedWork = computed(() => {
  if (!ticket.value) return false;
  return !!ticket.value.parent_id || ticket.value.type === "epic";
});
</script>

<template>
  <!-- Loading -->
  <div v-if="isLoading" class="space-y-4">
    <Skeleton class="h-4 w-32" />
    <Skeleton class="h-7 w-3/4" />
    <Skeleton class="h-4 w-full" />
    <Skeleton class="h-4 w-2/3" />
  </div>

  <!-- Error -->
  <div v-else-if="errMessage" class="text-sm text-destructive">{{ errMessage }}</div>

  <!-- Loaded -->
  <div v-else-if="ticket" class="space-y-5">
    <!-- Title block (suppressed in drawer; chrome supplies the title there) -->
    <header v-if="!hideTitle" class="space-y-2">
      <!-- Breadcrumb: project name (always) + parent epic when applicable. -->
      <div class="text-xs text-muted-foreground flex items-center gap-1.5 flex-wrap">
        <span>{{ ticket.project.name }}</span>
        <template v-if="parent">
          <span class="text-muted-foreground/40">›</span>
          <button
            type="button"
            class="inline-flex items-center gap-1 hover:text-foreground transition-colors"
            @click="navigateToLinked(parent.key)"
          >
            <TypeIcon :type="parent.type" class="h-3 w-3" />
            <span class="font-mono">{{ parent.key }}</span>
            <span class="truncate max-w-[14rem]">{{ parent.title }}</span>
          </button>
        </template>
      </div>
      <h1 class="flex items-start gap-2 text-xl tracking-tight">
        <TypeIcon :type="ticket.type" class="mt-1" />
        <span class="font-mono text-muted-foreground">{{ ticket.key }}</span>
        <span class="font-semibold flex-1 min-w-0">{{ ticket.title }}</span>
      </h1>
    </header>

    <!-- Drawer-mode header: parent breadcrumb only when applicable. -->
    <header v-else-if="parent" class="text-xs text-muted-foreground flex items-center gap-1.5">
      <span class="text-muted-foreground/60">Parent:</span>
      <button
        type="button"
        class="inline-flex items-center gap-1 hover:text-foreground transition-colors"
        @click="navigateToLinked(parent.key)"
      >
        <TypeIcon :type="parent.type" class="h-3 w-3" />
        <span class="font-mono">{{ parent.key }}</span>
        <span class="truncate max-w-[14rem]">{{ parent.title }}</span>
      </button>
    </header>

    <!-- Meta row: type · assignee · priority on the left, transition on the
         right. Wraps the transition under the meta when narrow. -->
    <div class="space-y-2">
      <div class="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
        <div class="flex flex-wrap items-center gap-x-1 gap-y-1 flex-1 min-w-0">
          <span class="inline-flex items-center gap-1.5 capitalize text-foreground/90 px-1.5">
            <TypeIcon :type="ticket.type" />
            {{ ticket.type }}
          </span>
          <span class="text-muted-foreground/40">·</span>
          <AssigneeEditor :ticket="ticket" />
          <span class="text-muted-foreground/40">·</span>
          <PriorityEditor :ticket="ticket" />
        </div>
        <TransitionButton :ticket="ticket" :allowed-statuses="allowedStatuses" />
      </div>

      <!-- Status + labels (editable) on one row. The pipe separator only
           renders when there's something to separate. -->
      <div class="flex flex-wrap items-center gap-2">
        <StatusBadge :category="ticket.status.category" :display-name="ticket.status.display_name" />
        <span class="text-muted-foreground/40 text-sm select-none">|</span>
        <LabelEditor :ticket="ticket" />
      </div>
    </div>

    <!-- Linked work: parent breadcrumb (mirrored) + sub-tickets for epics. -->
    <LinkedWork
      v-if="showLinkedWork"
      :parent="parent"
      :parent-loading="parentLoading"
      :children="children"
      :children-loading="childrenLoading"
      :is-epic="ticket.type === 'epic'"
      @navigate="navigateToLinked"
    />

    <!-- Tabs -->
    <div class="border-b">
      <nav class="flex gap-4 -mb-px">
        <button
          v-for="t in (['description','activity'] as Tab[])"
          :key="t"
          type="button"
          :class="cn(
            'pb-2 text-sm border-b-2 capitalize transition-colors',
            activeTab === t
              ? 'border-primary text-foreground'
              : 'border-transparent text-muted-foreground hover:text-foreground',
          )"
          @click="activeTab = t"
        >
          {{ t }}
          <span v-if="t === 'description'" class="ml-1.5 text-xs text-muted-foreground/70">
            ({{ ticket.comments.length }})
          </span>
        </button>
      </nav>
    </div>

    <!-- Description tab -->
    <template v-if="activeTab === 'description'">
      <DescriptionEditor :ticket="ticket" />

      <section v-if="ticket.attachments.length > 0">
        <h3 class="text-xs uppercase tracking-wider text-muted-foreground mb-2">
          Files ({{ ticket.attachments.length }})
        </h3>
        <ul class="space-y-1.5">
          <li v-for="a in ticket.attachments" :key="a.id">
            <AttachmentLink :attachment="a" />
          </li>
        </ul>
      </section>

      <section>
        <h3 class="text-xs uppercase tracking-wider text-muted-foreground mb-3">
          Comments
        </h3>
        <ul v-if="ticket.comments.length > 0" class="space-y-4">
          <CommentItem v-for="c in ticket.comments" :key="c.id" :comment="c" />
        </ul>
        <p v-else class="text-sm text-muted-foreground italic mb-3">No comments yet.</p>

        <div class="mt-4">
          <CommentComposer :ticket-key="ticket.key" />
        </div>
      </section>
    </template>

    <!-- Activity tab -->
    <template v-else>
      <ActivityList :events="events" :loading="eventsLoading" />
    </template>
  </div>
</template>
