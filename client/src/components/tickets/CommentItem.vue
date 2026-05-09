<script setup lang="ts">
import { computed } from "vue";
import { formatDistanceToNow } from "date-fns";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import Markdown from "@/components/markdown/Markdown.vue";
import AttachmentLink from "./AttachmentLink.vue";
import type { Comment } from "@switchyard/shared";

const props = defineProps<{ comment: Comment }>();

const initials = computed(() => {
  const name = props.comment.author.name;
  return name.split(/\s+/).map((p) => p[0]?.toUpperCase() ?? "").slice(0, 2).join("");
});

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
    <Avatar class="h-7 w-7 shrink-0">
      <AvatarFallback class="text-[10px]">{{ initials }}</AvatarFallback>
    </Avatar>
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
