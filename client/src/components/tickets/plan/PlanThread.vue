<script setup lang="ts">
import { computed, ref, nextTick, useTemplateRef } from "vue";
import { MessageSquare, Loader2 } from "lucide-vue-next";
import CommentItem from "@/components/tickets/CommentItem.vue";
import { Button } from "@/components/ui/button";
import type { Comment } from "@switchyard/shared";

// One anchored comment thread (the whole plan, a section, or a single
// criterion). Presentational: the parent owns the comments query + the post
// mutation and passes the already-anchored subset down. Read top-down,
// oldest→newest, the way a PR conversation reads.
const props = withDefaults(defineProps<{
  comments: Comment[];
  canWrite: boolean;
  posting?: boolean;
  pendingCommentId?: string | null;
  // Compact threads (per-criterion) keep the composer collapsed behind a Reply
  // affordance; the plan-level thread opens it inline.
  compact?: boolean;
  placeholder?: string;
}>(), {
  posting: false,
  pendingCommentId: null,
  compact: false,
  placeholder: "Add to the discussion… markdown supported, Ctrl+Enter to send.",
});

const emit = defineEmits<{
  post: [body: string];
  editComment: [id: string, body: string];
  deleteComment: [id: string];
}>();

const ordered = computed(() =>
  [...props.comments].sort((a, b) => a.created_at.localeCompare(b.created_at)),
);

const draft = ref("");
const composerOpen = ref(!props.compact);
const areaRef = useTemplateRef<HTMLTextAreaElement>("areaRef");

async function openComposer() {
  composerOpen.value = true;
  await nextTick();
  areaRef.value?.focus();
}

function send() {
  const trimmed = draft.value.trim();
  if (trimmed.length === 0 || props.posting) return;
  emit("post", trimmed);
  draft.value = "";
  if (props.compact) composerOpen.value = false;
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === "Escape" && props.compact) {
    e.preventDefault();
    composerOpen.value = false;
  } else if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
    e.preventDefault();
    send();
  }
}
</script>

<template>
  <div class="space-y-3">
    <ul v-if="ordered.length > 0" class="space-y-3">
      <CommentItem
        v-for="c in ordered"
        :key="c.id"
        :comment="c"
        :saving="pendingCommentId === c.id"
        @edit="(id, body) => emit('editComment', id, body)"
        @delete="(id) => emit('deleteComment', id)"
      />
    </ul>

    <!-- Composer -->
    <div v-if="canWrite">
      <Button
        v-if="!composerOpen"
        type="button"
        variant="ghost"
        size="sm"
        class="h-7 text-xs text-muted-foreground"
        @click="openComposer"
      >
        <MessageSquare class="h-3.5 w-3.5 mr-1.5" />
        {{ ordered.length > 0 ? "Reply" : "Comment" }}
      </Button>

      <div v-else class="rounded-md border bg-background p-2">
        <textarea
          ref="areaRef"
          v-model="draft"
          rows="2"
          class="w-full bg-transparent text-sm leading-relaxed focus:outline-none resize-y placeholder:text-muted-foreground"
          :placeholder="placeholder"
          @keydown="onKeydown"
        />
        <div class="flex items-center justify-end gap-2 pt-1.5 mt-1.5 border-t">
          <Button
            v-if="compact"
            type="button"
            variant="ghost"
            size="sm"
            class="h-7 text-xs"
            @click="composerOpen = false"
          >
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            class="h-7"
            :disabled="draft.trim().length === 0 || posting"
            @click="send"
          >
            <Loader2 v-if="posting" class="h-3.5 w-3.5 mr-1.5 animate-spin" />
            Send
          </Button>
        </div>
      </div>
    </div>

    <p v-else-if="ordered.length === 0" class="text-xs text-muted-foreground italic">
      No comments.
    </p>
  </div>
</template>
