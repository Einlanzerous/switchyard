<script setup lang="ts">
import { computed } from "vue";
import { formatDistanceToNow } from "date-fns";
import {
  Plus, Pencil, ArrowRight, UserCheck, MessageSquare, Paperclip, X, CheckCircle2, Send, Trash2,
  Link2, GitPullRequest, FolderInput,
} from "lucide-vue-next";
import { Skeleton } from "@/components/ui/skeleton";
import StatusBadge from "./StatusBadge.vue";
import type { Event as ApiEvent, EventType } from "@switchyard/shared";

const props = defineProps<{
  events: ApiEvent[];
  loading?: boolean;
}>();

// Map each event type to an icon + a short verb. Field-level diffs render
// inline below the verb; status changes render as before → after pills.
const META: Record<EventType, { icon: any; verb: string }> = {
  "ticket.created": { icon: Plus, verb: "created the ticket" },
  "ticket.updated": { icon: Pencil, verb: "updated" },
  "ticket.status_changed": { icon: ArrowRight, verb: "changed status" },
  "ticket.assigned": { icon: UserCheck, verb: "changed the assignee" },
  "ticket.closed": { icon: CheckCircle2, verb: "closed the ticket" },
  "ticket.released": { icon: Send, verb: "released the ticket" },
  "ticket.deleted": { icon: Trash2, verb: "deleted the ticket" },
  "ticket.moved": { icon: FolderInput, verb: "moved the ticket to another project" },
  "ticket.link_added": { icon: Link2, verb: "added a link" },
  "ticket.link_removed": { icon: Link2, verb: "removed a link" },
  "ticket.external_ref_added": { icon: GitPullRequest, verb: "attached an external reference" },
  "ticket.external_ref_removed": { icon: GitPullRequest, verb: "detached an external reference" },
  "ticket.external_ref_state_changed": { icon: GitPullRequest, verb: "external reference state changed" },
  "comment.created": { icon: MessageSquare, verb: "commented" },
  "comment.updated": { icon: MessageSquare, verb: "edited a comment" },
  "comment.deleted": { icon: MessageSquare, verb: "deleted a comment" },
  "attachment.added": { icon: Paperclip, verb: "added an attachment" },
  "attachment.removed": { icon: X, verb: "removed an attachment" },
  "project.created": { icon: Plus, verb: "created the project" },
  "project.updated": { icon: Pencil, verb: "updated the project" },
  "project.deleted": { icon: Trash2, verb: "deleted the project" },
};

const ordered = computed(() => [...props.events].reverse());

function relative(iso: string): string {
  try { return formatDistanceToNow(new Date(iso), { addSuffix: true }); }
  catch { return ""; }
}

// Per-field friendly label. Most field names are already readable
// (priority, parent_id is rare in audit) so this is a small allowlist.
const FIELD_LABELS: Record<string, string> = {
  due_date: "Due date",
  parent_id: "Parent",
};
function fmtFieldName(name: string): string {
  return FIELD_LABELS[name] ?? name;
}

function fmtField(v: unknown, field?: string): string {
  if (v === null || v === undefined) return "—";
  if (field === "due_date" && typeof v === "string") {
    try {
      const d = new Date(v);
      if (!Number.isNaN(d.getTime())) {
        return d.toLocaleDateString(undefined, { dateStyle: "medium" });
      }
    } catch { /* fall through */ }
  }
  if (typeof v === "string") return v.length > 80 ? v.slice(0, 80) + "…" : v;
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}
</script>

<template>
  <div v-if="loading" class="space-y-2">
    <Skeleton v-for="n in 4" :key="n" class="h-8 w-full" />
  </div>

  <ol v-else-if="ordered.length > 0" class="space-y-3">
    <li v-for="e in ordered" :key="e.id" class="flex gap-3 text-sm">
      <component
        :is="META[e.event]?.icon ?? Pencil"
        class="h-4 w-4 mt-0.5 text-muted-foreground shrink-0"
      />
      <div class="flex-1 min-w-0 space-y-1">
        <div class="text-xs">
          <span class="text-foreground font-medium">{{ e.actor?.name ?? "system" }}</span>
          <span class="text-muted-foreground">
            {{ " " + (META[e.event]?.verb ?? e.event) }} · {{ relative(e.occurred_at) }}
          </span>
        </div>

        <!-- Status change: show pills -->
        <div
          v-if="e.changes?.status"
          class="flex flex-wrap items-center gap-1.5 text-xs"
        >
          <StatusBadge
            v-if="e.changes.status.from"
            :category="e.changes.status.from.category"
            :display-name="e.changes.status.from.display_name"
            size="sm"
          />
          <span v-else class="text-muted-foreground italic">·</span>
          <ArrowRight class="h-3 w-3 text-muted-foreground" />
          <StatusBadge
            :category="e.changes.status.to.category"
            :display-name="e.changes.status.to.display_name"
            size="sm"
          />
          <span v-if="e.changes.status.resolution" class="text-muted-foreground">
            · resolution <span class="text-foreground capitalize">{{ e.changes.status.resolution }}</span>
          </span>
        </div>

        <!-- Field-level updates -->
        <ul
          v-if="e.changes?.fields && e.changes.fields.length > 0"
          class="text-xs space-y-0.5 text-muted-foreground"
        >
          <li v-for="(f, idx) in e.changes.fields" :key="idx">
            <span class="font-medium text-foreground">{{ fmtFieldName(f.field) }}</span>:
            <span class="line-through">{{ fmtField(f.from, f.field) }}</span>
            <ArrowRight class="inline h-3 w-3 mx-1" />
            <span class="text-foreground">{{ fmtField(f.to, f.field) }}</span>
          </li>
        </ul>

        <!-- Comment body -->
        <div
          v-if="e.event === 'comment.created' && (e.payload as any)?.comment_body"
          class="text-xs text-muted-foreground line-clamp-2 italic"
        >“{{ (e.payload as any).comment_body }}”</div>
      </div>
    </li>
  </ol>

  <p v-else class="text-sm text-muted-foreground italic">No activity yet.</p>
</template>
