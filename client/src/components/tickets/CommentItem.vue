<script setup lang="ts">
import { computed, ref, nextTick, useTemplateRef } from "vue";
import { formatDistanceToNow } from "date-fns";
import { Pencil, Trash2, Loader2 } from "lucide-vue-next";
import UserAvatar from "@/components/UserAvatar.vue";
import Markdown from "@/components/markdown/Markdown.vue";
import AttachmentLink from "./AttachmentLink.vue";
import { Button } from "@/components/ui/button";
import { useAuthStore } from "@/stores/auth";
import type { Comment } from "@switchyard/shared";

const props = defineProps<{
  comment: Comment;
  // True while a save/delete mutation for this comment is in flight.
  saving?: boolean;
}>();

const emit = defineEmits<{
  edit: [id: string, body: string];
  delete: [id: string];
}>();

const auth = useAuthStore();

// Author-only actions. A deleted comment exposes no actions.
const isAuthor = computed(
  () => !props.comment.deleted && auth.me?.id === props.comment.author.id
);

const when = computed(() => {
  try {
    return formatDistanceToNow(new Date(props.comment.created_at), { addSuffix: true });
  } catch {
    return "";
  }
});

const editing = ref(false);
const draft = ref("");
const editAreaRef = useTemplateRef<HTMLTextAreaElement>("editAreaRef");

async function startEdit() {
  draft.value = props.comment.body;
  editing.value = true;
  await nextTick();
  editAreaRef.value?.focus();
}

function cancelEdit() {
  editing.value = false;
  draft.value = "";
}

function saveEdit() {
  const trimmed = draft.value.trim();
  if (trimmed.length === 0 || trimmed === props.comment.body) {
    cancelEdit();
    return;
  }
  emit("edit", props.comment.id, trimmed);
  editing.value = false;
}

function requestDelete() {
  if (window.confirm("Delete this comment? This cannot be undone.")) {
    emit("delete", props.comment.id);
  }
}

function onEditKeydown(e: KeyboardEvent) {
  if (e.key === "Escape") {
    e.preventDefault();
    cancelEdit();
  } else if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
    e.preventDefault();
    saveEdit();
  }
}
</script>

<template>
  <li class="group flex gap-3">
    <UserAvatar :user="comment.author" size="md" class="shrink-0" />
    <div class="flex-1 min-w-0 space-y-1.5">
      <div class="flex items-center gap-1.5 text-xs text-muted-foreground">
        <span class="text-foreground font-medium">{{ comment.author.name }}</span>
        <span>{{ when }}</span>
        <span v-if="comment.edited" class="italic">(edited)</span>

        <span v-if="saving" class="ml-auto inline-flex items-center">
          <Loader2 class="h-3.5 w-3.5 animate-spin" />
        </span>
        <span
          v-else-if="isAuthor && !editing"
          class="ml-auto inline-flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100"
        >
          <Button
            type="button"
            variant="ghost"
            size="icon"
            class="h-6 w-6 text-muted-foreground hover:text-foreground"
            aria-label="Edit comment"
            @click="startEdit"
          >
            <Pencil class="h-3.5 w-3.5" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            class="h-6 w-6 text-muted-foreground hover:text-destructive"
            aria-label="Delete comment"
            @click="requestDelete"
          >
            <Trash2 class="h-3.5 w-3.5" />
          </Button>
        </span>
      </div>

      <p v-if="comment.deleted" class="text-sm italic text-muted-foreground">[deleted]</p>

      <template v-else-if="editing">
        <textarea
          ref="editAreaRef"
          v-model="draft"
          rows="3"
          class="w-full rounded-md border bg-background p-2 text-sm leading-relaxed focus:outline-none focus:ring-1 focus:ring-ring resize-y"
          @keydown="onEditKeydown"
        />
        <div class="flex items-center gap-2">
          <Button type="button" size="sm" class="h-7" @click="saveEdit">Save</Button>
          <Button type="button" variant="ghost" size="sm" class="h-7" @click="cancelEdit">
            Cancel
          </Button>
        </div>
      </template>

      <template v-else>
        <Markdown :body="comment.body" />
        <ul v-if="comment.attachments.length > 0" class="space-y-1.5">
          <li v-for="a in comment.attachments" :key="a.id">
            <AttachmentLink :attachment="a" />
          </li>
        </ul>
      </template>
    </div>
  </li>
</template>
