<script setup lang="ts">
import { computed } from "vue";
import { formatDistanceToNow } from "date-fns";
import UserAvatar from "@/components/UserAvatar.vue";
import Markdown from "@/components/markdown/Markdown.vue";
import AttachmentLink from "./AttachmentLink.vue";
import type { Comment } from "@switchyard/shared";

const props = defineProps<{ comment: Comment }>();

const when = computed(() => {
  try {
    return formatDistanceToNow(new Date(props.comment.created_at), { addSuffix: true });
  } catch {
    return "";
  }
});
</script>

<template>
  <li class="flex gap-3">
    <UserAvatar :user="comment.author" size="md" class="shrink-0" />
    <div class="flex-1 min-w-0 space-y-1.5">
      <div class="text-xs text-muted-foreground">
        <span class="text-foreground font-medium">{{ comment.author.name }}</span>
        <span class="ml-1.5">{{ when }}</span>
      </div>
      <Markdown :body="comment.body" />
      <ul v-if="comment.attachments.length > 0" class="space-y-1.5">
        <li v-for="a in comment.attachments" :key="a.id">
          <AttachmentLink :attachment="a" />
        </li>
      </ul>
    </div>
  </li>
</template>
