<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { useMutation, useQueryClient } from "@tanstack/vue-query";
import { Repeat } from "lucide-vue-next";
import { toast } from "vue-sonner";
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
import ExternalRefsSection from "./ExternalRefsSection.vue";
import PriorityEditor from "./PriorityEditor.vue";
import DueDateEditor from "./DueDateEditor.vue";
import AssigneeEditor from "./AssigneeEditor.vue";
import ParentEpicEditor from "./ParentEpicEditor.vue";
import LabelEditor from "./LabelEditor.vue";
import CreateTicketDialog from "./CreateTicketDialog.vue";
import { cn } from "@/lib/utils";
import { useTicketDetail } from "@/composables/useTicketDetail";
import { useProjectPermissions, provideTicketCanWrite } from "@/composables/useProjectPermissions";
import { api } from "@/lib/api";
import { queryKeys } from "@/lib/queryKeys";
import type { TicketLinkType } from "@switchyard/shared";

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

// Write capability on this ticket's project, shared down to the inline editors
// / transition / comment composer (6.5/6.6). A viewer sees the ticket but no
// write affordances; the server enforces the same regardless.
const { canWrite } = useProjectPermissions(() => ticket.value?.project.key ?? null);
provideTicketCanWrite(canWrite);

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

// Recurring-template back-link. The ticket's `template_id` is just the
// UUID; route the user to the project Recurring tab so they can see the
// template in context (and edit/disable it).
function goToTemplate() {
  if (!ticket.value) return;
  router.push(`/projects/${ticket.value.project.key}/setup/recurring`);
}

// LinkedWork renders three sections (parent, children, typed links). The
// children section always renders for anything that can be a parent (epic →
// tasks, task/bug/spike → subtasks); subtasks are leaves and never show it.
const canHaveChildren = computed(() => !!ticket.value && ticket.value.type !== "subtask");

// New child default: an epic's children are tasks; a task/bug/spike's children
// are subtasks. Drives the "Add sub-ticket" dialog's preselected type.
const childDefaultType = computed(() => (ticket.value?.type === "epic" ? "task" : "subtask"));

// Show LinkedWork whenever any of its sections is meaningful: there's a parent,
// this ticket can have children, or any cross-ticket links exist. We always
// render so users can add their first link.
const showLinkedWork = computed(() => !!ticket.value);

// Newest-first: real use is "what's the latest?", then read back as needed.
// Sort defensively here rather than relying on API order.
const sortedComments = computed(() => {
  if (!ticket.value) return [];
  return [...ticket.value.comments].sort((a, b) =>
    b.created_at.localeCompare(a.created_at),
  );
});

const qc = useQueryClient();

const addLinkMutation = useMutation({
  mutationFn: async (input: { type: TicketLinkType; target: string }) => {
    if (!ticket.value) throw new Error("no ticket loaded");
    const { error } = await api.POST("/v1/tickets/{idOrKey}/links", {
      params: { path: { idOrKey: ticket.value.key } },
      body: input,
    });
    if (error) throw error;
  },
  onSuccess: () => {
    qc.invalidateQueries({ queryKey: queryKeys.ticket(idOrKey.value) });
    toast.success("Link added");
  },
  onError: (err: unknown) => {
    const msg = (err as { error?: { message?: string } })?.error?.message ?? "Failed to add link";
    toast.error(msg);
  },
});

// ─── External refs mutations ────────────────────────────────────────────────

const addExternalRefMutation = useMutation({
  mutationFn: async (url: string) => {
    if (!ticket.value) throw new Error("no ticket loaded");
    const { error } = await api.POST("/v1/tickets/{idOrKey}/external-refs", {
      params: { path: { idOrKey: ticket.value.key } },
      body: { url },
    });
    if (error) throw error;
  },
  onSuccess: () => {
    qc.invalidateQueries({ queryKey: queryKeys.ticket(idOrKey.value) });
    toast.success("External reference attached");
  },
  onError: (err: unknown) => {
    const msg = (err as { error?: { message?: string } })?.error?.message ?? "Failed to attach";
    toast.error(msg);
  },
});

const removingRefId = ref<string | null>(null);
const removeExternalRefMutation = useMutation({
  mutationFn: async (refId: string) => {
    removingRefId.value = refId;
    const { error } = await api.DELETE("/v1/tickets/external-refs/{id}", { params: { path: { id: refId } } });
    if (error) throw error;
  },
  onSuccess: () => {
    qc.invalidateQueries({ queryKey: queryKeys.ticket(idOrKey.value) });
    toast.success("External reference detached");
  },
  onError: (err: unknown) => {
    const msg = (err as { error?: { message?: string } })?.error?.message ?? "Failed to detach";
    toast.error(msg);
  },
  onSettled: () => { removingRefId.value = null; },
});

const removingLinkId = ref<string | null>(null);
const removeLinkMutation = useMutation({
  mutationFn: async (linkId: string) => {
    removingLinkId.value = linkId;
    const { error } = await api.DELETE("/v1/tickets/links/{id}", { params: { path: { id: linkId } } });
    if (error) throw error;
  },
  onSuccess: () => {
    qc.invalidateQueries({ queryKey: queryKeys.ticket(idOrKey.value) });
    toast.success("Link removed");
  },
  onError: (err: unknown) => {
    const msg = (err as { error?: { message?: string } })?.error?.message ?? "Failed to remove link";
    toast.error(msg);
  },
  onSettled: () => { removingLinkId.value = null; },
});

// ─── Comment edit / delete ──────────────────────────────────────────────────

// Id of the comment currently being edited/deleted, so its row can show a
// spinner and suppress its actions while the request is in flight.
const pendingCommentId = ref<string | null>(null);

const editCommentMutation = useMutation({
  mutationFn: async ({ id, body }: { id: string; body: string }) => {
    const { error } = await api.PATCH("/v1/comments/{id}", {
      params: { path: { id } },
      body: { body },
    });
    if (error) throw error;
  },
  onSuccess: () => {
    qc.invalidateQueries({ queryKey: queryKeys.ticket(idOrKey.value) });
    toast.success("Comment updated");
  },
  onError: (err: unknown) => {
    const msg = (err as { error?: { message?: string } })?.error?.message ?? "Failed to update comment";
    toast.error(msg);
  },
  onSettled: () => { pendingCommentId.value = null; },
});

const deleteCommentMutation = useMutation({
  mutationFn: async (id: string) => {
    const { error } = await api.DELETE("/v1/comments/{id}", { params: { path: { id } } });
    if (error) throw error;
  },
  onSuccess: () => {
    qc.invalidateQueries({ queryKey: queryKeys.ticket(idOrKey.value) });
    toast.success("Comment deleted");
  },
  onError: (err: unknown) => {
    const msg = (err as { error?: { message?: string } })?.error?.message ?? "Failed to delete comment";
    toast.error(msg);
  },
  onSettled: () => { pendingCommentId.value = null; },
});

function onEditComment(id: string, body: string) {
  pendingCommentId.value = id;
  editCommentMutation.mutate({ id, body });
}

function onDeleteComment(id: string) {
  pendingCommentId.value = id;
  deleteCommentMutation.mutate(id);
}

// "Add sub-ticket" from the sub-tickets header opens CreateTicketDialog preset
// with this ticket as the parent (an epic gets a task child; a task/bug/spike
// gets a subtask child — see childDefaultType + the template binding below).
const createSubTicketOpen = ref(false);
function openAddSubTicket() {
  createSubTicketOpen.value = true;
}
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
      <!-- v4 full-page title: 26px/700 with a scaled-up type icon + 16px
           mono key. -->
      <h1 class="flex items-start gap-2.5 text-[26px] leading-tight tracking-[-0.01em]">
        <TypeIcon :type="ticket.type" class="mt-1 h-[26px] w-[26px]" />
        <span class="mt-1 font-mono text-base text-ink-3">{{ ticket.key }}</span>
        <span class="font-bold flex-1 min-w-0">{{ ticket.title }}</span>
        <button
          v-if="ticket.template_id"
          type="button"
          class="mt-1 inline-flex items-center gap-1 rounded-full bg-indigo-500/15 text-indigo-600 dark:text-indigo-400 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider hover:bg-indigo-500/25 transition-colors"
          :title="`Materialized from a recurring template`"
          @click="goToTemplate"
        >
          <Repeat class="h-3 w-3" />
          Recurring
        </button>
      </h1>
    </header>

    <!-- Drawer-mode header: the v4 bordered parent-row bar (epic icon +
         key + title + status pill). -->
    <header v-else-if="parent">
      <button
        type="button"
        class="flex h-[38px] w-full items-center gap-2 rounded-md border bg-card px-2.5 text-left text-sm hover:bg-accent/40 transition-colors"
        @click="navigateToLinked(parent.key)"
      >
        <TypeIcon :type="parent.type" class="h-3.5 w-3.5 shrink-0" />
        <span class="font-mono text-xs text-ink-3 shrink-0">{{ parent.key }}</span>
        <span class="flex-1 min-w-0 truncate font-medium">{{ parent.title }}</span>
        <StatusBadge
          :category="parent.status.category"
          :display-name="parent.status.display_name"
          size="sm"
        />
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
          <span class="text-muted-foreground/40">·</span>
          <DueDateEditor :ticket="ticket" :is-open="ticket.status.category !== 'closed'" />
          <!-- Parent epic — epics themselves can't have a parent, so hide it there. -->
          <template v-if="ticket.type !== 'epic'">
            <span class="text-muted-foreground/40">·</span>
            <ParentEpicEditor :ticket="ticket" />
          </template>
        </div>
        <TransitionButton v-if="canWrite" :ticket="ticket" :allowed-statuses="allowedStatuses" />
      </div>

      <!-- Status + labels (editable) on one row. The pipe separator only
           renders when there's something to separate. -->
      <div class="flex flex-wrap items-center gap-2">
        <StatusBadge :category="ticket.status.category" :display-name="ticket.status.display_name" />
        <span class="text-muted-foreground/40 text-sm select-none">|</span>
        <LabelEditor :ticket="ticket" />
      </div>
    </div>

    <!-- Linked work: parent breadcrumb (mirrored) + sub-tickets for epics + typed links. -->
    <LinkedWork
      v-if="showLinkedWork"
      :parent="parent"
      :parent-loading="parentLoading"
      :children="children"
      :children-loading="childrenLoading"
      :can-have-children="canHaveChildren"
      :parent-type="ticket.type"
      :links="ticket.links ?? []"
      :adding-link="addLinkMutation.isPending.value"
      :removing-link-id="removingLinkId"
      :external-refs-count="(ticket.external_refs ?? []).length"
      @navigate="navigateToLinked"
      @add-link="(p) => addLinkMutation.mutate(p)"
      @remove-link="(id) => removeLinkMutation.mutate(id)"
      @add-sub-ticket="openAddSubTicket"
    />

    <!-- Create-sub-ticket dialog: preset with this epic as parent (in its
         project). Mounted here so both the drawer and full-page renders of
         TicketBody share one wiring. -->
    <CreateTicketDialog
      v-model:open="createSubTicketOpen"
      :default-project-key="ticket.project.key"
      :default-parent-id="ticket.id"
      :default-type="childDefaultType"
    />

    <!-- External references (GitHub PR / issue / commit / Actions / generic) -->
    <ExternalRefsSection
      :refs="ticket.external_refs ?? []"
      :adding="addExternalRefMutation.isPending.value"
      :removing-id="removingRefId"
      @add="(url) => addExternalRefMutation.mutate(url)"
      @remove="(id) => removeExternalRefMutation.mutate(id)"
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
        <h3 class="eyebrow mb-2">
          Files ({{ ticket.attachments.length }})
        </h3>
        <ul class="space-y-1.5">
          <li v-for="a in ticket.attachments" :key="a.id">
            <AttachmentLink :attachment="a" />
          </li>
        </ul>
      </section>

      <section class="border-t pt-6 mt-6">
        <h3 class="eyebrow mb-3">
          Comments
        </h3>

        <div class="mb-4">
          <CommentComposer v-if="canWrite" :ticket-key="ticket.key" />
          <!-- @vue-expect-error this Vue version's DOM types don't include a data-* index signature for dynamic binds -->
          <p v-else class="text-sm text-muted-foreground italic" :data-testid="'comments-readonly'">
            You have read-only access — commenting is disabled.
          </p>
        </div>

        <ul v-if="sortedComments.length > 0" class="space-y-4">
          <CommentItem
            v-for="c in sortedComments"
            :key="c.id"
            :comment="c"
            :saving="pendingCommentId === c.id"
            @edit="onEditComment"
            @delete="onDeleteComment"
          />
        </ul>
        <p v-else class="text-sm text-muted-foreground italic">No comments yet.</p>
      </section>
    </template>

    <!-- Activity tab -->
    <template v-else>
      <ActivityList :events="events" :loading="eventsLoading" />
    </template>
  </div>
</template>
