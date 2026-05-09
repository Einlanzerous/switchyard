<script setup lang="ts">
import { ref } from "vue";
import { Download, Loader2, FileText, Image as ImageIcon, Music } from "lucide-vue-next";
import { toast } from "vue-sonner";
import { downloadAttachment } from "@/lib/download";
import type { Attachment } from "@switchyard/shared";

const props = defineProps<{
  attachment: Attachment;
}>();

const downloading = ref(false);

const ICONS = { image: ImageIcon, audio: Music, text: FileText } as const;

async function trigger() {
  if (downloading.value) return;
  downloading.value = true;
  try {
    await downloadAttachment(props.attachment.id, props.attachment.original_name);
  } catch (err) {
    toast.error(err instanceof Error ? err.message : "Download failed");
  } finally {
    downloading.value = false;
  }
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
</script>

<template>
  <button
    type="button"
    class="flex items-center gap-2 w-full rounded-md border bg-card px-3 py-2 text-left text-sm hover:bg-accent/40 transition-colors disabled:opacity-60"
    :disabled="downloading"
    @click="trigger"
  >
    <component :is="ICONS[attachment.kind]" class="h-4 w-4 text-muted-foreground shrink-0" />
    <span class="flex-1 min-w-0 truncate">
      {{ attachment.original_name ?? attachment.id }}
    </span>
    <span class="text-xs text-muted-foreground shrink-0">{{ fmtBytes(attachment.size_bytes) }}</span>
    <Loader2 v-if="downloading" class="h-3.5 w-3.5 animate-spin text-muted-foreground" />
    <Download v-else class="h-3.5 w-3.5 text-muted-foreground" />
  </button>
</template>
