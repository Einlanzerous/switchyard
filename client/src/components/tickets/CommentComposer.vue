<script setup lang="ts">
import { ref, computed, useTemplateRef } from "vue";
import { useMutation, useQueryClient } from "@tanstack/vue-query";
import { Paperclip, Loader2, X, Image as ImageIcon, Music, FileText } from "lucide-vue-next";
import { toast } from "vue-sonner";
import { Button } from "@/components/ui/button";
import { api, getStoredToken } from "@/lib/api";
import { queryKeys } from "@/lib/queryKeys";

const props = defineProps<{
  ticketKey: string;
}>();

const qc = useQueryClient();

const body = ref("");
const pendingFiles = ref<File[]>([]);
const isDragging = ref(false);
const fileInput = useTemplateRef<HTMLInputElement>("fileInput");
const submitting = ref(false);

function classifyKind(file: File): "image" | "audio" | "text" | null {
  if (file.type.startsWith("image/")) return "image";
  if (file.type.startsWith("audio/")) return "audio";
  if (file.type.startsWith("text/") || file.name.endsWith(".md") || file.name.endsWith(".txt")) return "text";
  return null;
}

function iconFor(file: File) {
  const kind = classifyKind(file);
  return kind === "image" ? ImageIcon : kind === "audio" ? Music : FileText;
}

function addFiles(files: FileList | File[]) {
  for (const f of Array.from(files)) {
    if (!classifyKind(f)) {
      toast.warning(`Skipping ${f.name}: only image/audio/text files supported`);
      continue;
    }
    pendingFiles.value.push(f);
  }
}

function onPick(e: Event) {
  const target = e.target as HTMLInputElement;
  if (target.files) addFiles(target.files);
  target.value = "";
}

function onDrop(e: DragEvent) {
  e.preventDefault();
  isDragging.value = false;
  if (e.dataTransfer?.files) addFiles(e.dataTransfer.files);
}

function onDragOver(e: DragEvent) {
  e.preventDefault();
  isDragging.value = true;
}

function onDragLeave() { isDragging.value = false; }

function removeFile(idx: number) {
  pendingFiles.value.splice(idx, 1);
}

const canSubmit = computed(() =>
  !submitting.value && (body.value.trim().length > 0 || pendingFiles.value.length > 0)
);

const createMutation = useMutation({
  mutationFn: async () => {
    const trimmed = body.value.trim();
    // Comments require a body — if there are only files but no text, attach
    // them to the ticket directly (no comment row).
    let commentId: string | null = null;
    if (trimmed.length > 0) {
      const { data, error } = await api.POST("/v1/tickets/{idOrKey}/comments", {
        params: { path: { idOrKey: props.ticketKey } },
        body: { body: trimmed },
      });
      if (error) throw error;
      commentId = data?.id ?? null;
    }

    // Upload files via raw fetch — openapi-fetch's params shape doesn't
    // map cleanly to multipart bodies. We add the auth header by hand.
    const token = getStoredToken();
    for (const file of pendingFiles.value) {
      const kind = classifyKind(file);
      if (!kind) continue;
      const fd = new FormData();
      fd.append("file", file);
      fd.append("kind", kind);
      if (commentId) fd.append("comment_id", commentId);

      const res = await fetch(
        `/v1/tickets/${encodeURIComponent(props.ticketKey)}/attachments`,
        {
          method: "POST",
          headers: token ? { Authorization: `Bearer ${token}` } : {},
          body: fd,
        }
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
        throw new Error(body.error?.message ?? `Upload of ${file.name} failed`);
      }
    }
  },
  onSuccess: () => {
    body.value = "";
    pendingFiles.value = [];
    qc.invalidateQueries({ queryKey: queryKeys.ticket(props.ticketKey) });
    qc.invalidateQueries({ queryKey: queryKeys.ticketEvents(props.ticketKey) });
    qc.invalidateQueries({ queryKey: queryKeys.ticketComments(props.ticketKey) });
    toast.success("Comment posted");
  },
});

async function submit() {
  if (!canSubmit.value) return;
  submitting.value = true;
  try {
    await createMutation.mutateAsync();
  } finally {
    submitting.value = false;
  }
}

function onKeydown(e: KeyboardEvent) {
  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
    e.preventDefault();
    void submit();
  }
}
</script>

<template>
  <div
    :class="[
      'rounded-md border p-2 transition-colors',
      isDragging ? 'border-primary bg-primary/5' : 'bg-background',
    ]"
    @dragover.stop="onDragOver"
    @dragleave.stop="onDragLeave"
    @drop.stop="onDrop"
  >
    <textarea
      v-model="body"
      rows="3"
      class="w-full bg-transparent text-sm leading-relaxed focus:outline-none resize-y placeholder:text-muted-foreground"
      placeholder="Write a comment… markdown supported, drop files anywhere on this card. Ctrl+Enter to send."
      @keydown="onKeydown"
    />

    <ul v-if="pendingFiles.length > 0" class="flex flex-wrap gap-1.5 pt-2 border-t mt-2">
      <li
        v-for="(f, idx) in pendingFiles"
        :key="`${f.name}-${idx}`"
        class="inline-flex items-center gap-1.5 rounded-md border bg-muted/40 pl-2 pr-1 py-1 text-xs"
      >
        <component :is="iconFor(f)" class="h-3 w-3 text-muted-foreground" />
        <span class="max-w-[12rem] truncate">{{ f.name }}</span>
        <button
          type="button"
          class="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label="Remove file"
          @click="removeFile(idx)"
        >
          <X class="h-3 w-3" />
        </button>
      </li>
    </ul>

    <div class="flex items-center justify-between pt-2 mt-2 border-t">
      <Button type="button" variant="ghost" size="sm" class="h-7 text-xs" @click="fileInput?.click()">
        <Paperclip class="h-3.5 w-3.5 mr-1" /> Attach
      </Button>
      <input
        ref="fileInput"
        type="file"
        multiple
        accept="image/*,audio/*,text/*,.md,.txt"
        class="hidden"
        @change="onPick"
      />
      <Button type="button" size="sm" class="h-7" :disabled="!canSubmit" @click="submit">
        <Loader2 v-if="submitting" class="h-3.5 w-3.5 mr-1.5 animate-spin" />
        Send
      </Button>
    </div>
  </div>
</template>
