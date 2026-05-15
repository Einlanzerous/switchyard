<script setup lang="ts">
import { computed, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useMutation, useQueryClient } from "@tanstack/vue-query";
import { ArrowLeft, Trash2, Loader2 } from "lucide-vue-next";
import { toast } from "vue-sonner";
import { Button } from "@/components/ui/button";
import TicketBody from "@/components/tickets/TicketBody.vue";
import { api } from "@/lib/api";
import { queryKeys } from "@/lib/queryKeys";

const route = useRoute();
const router = useRouter();
const qc = useQueryClient();

const idOrKey = computed(() => {
  const v = route.params.idOrKey;
  return typeof v === "string" ? v : Array.isArray(v) ? (v[0] ?? "") : "";
});

function back() {
  // Try to fall back to the ticket list if there's no nav history (deep link).
  if (window.history.state?.back) {
    router.back();
  } else {
    router.push("/tickets");
  }
}

// Two-step delete confirm — the destructive action lives ON the dedicated
// detail page (not the drawer), so a casual click on the row from the list
// can't blow up a ticket. Click "Delete" → button row swaps to Cancel +
// Confirm. Soft-delete only; the server keeps the row in the DB.
const confirming = ref(false);
const deleteMut = useMutation({
  mutationFn: async () => {
    const { error } = await api.DELETE("/v1/tickets/{idOrKey}", {
      params: { path: { idOrKey: idOrKey.value } },
    });
    if (error) throw error;
  },
  onSuccess: () => {
    qc.invalidateQueries({ queryKey: queryKeys.ticket(idOrKey.value) });
    qc.invalidateQueries({ queryKey: queryKeys.tickets() });
    qc.invalidateQueries({ queryKey: ["sw", "projects"] });
    qc.invalidateQueries({ queryKey: ["sw", "boards"] });
    toast.success(`Deleted ${idOrKey.value}`);
    back();
  },
  onError: (err) => {
    const msg = (err as { error?: { message?: string } })?.error?.message ?? "Delete failed";
    toast.error(msg);
    confirming.value = false;
  },
});
</script>

<template>
  <div class="container max-w-3xl py-8">
    <div class="flex items-center justify-between mb-4">
      <Button variant="ghost" size="sm" class="-ml-2 text-muted-foreground" @click="back">
        <ArrowLeft class="h-3.5 w-3.5 mr-1.5" /> Back
      </Button>
      <div v-if="!confirming" class="flex items-center">
        <Button
          variant="ghost"
          size="sm"
          class="h-8 px-2 text-muted-foreground hover:text-destructive"
          @click="confirming = true"
        >
          <Trash2 class="h-3.5 w-3.5 mr-1.5" /> Delete
        </Button>
      </div>
      <div v-else class="flex items-center gap-2">
        <Button variant="ghost" size="sm" class="h-8" @click="confirming = false">
          Cancel
        </Button>
        <Button
          variant="destructive"
          size="sm"
          class="h-8"
          :disabled="deleteMut.isPending.value"
          @click="deleteMut.mutate()"
        >
          <Loader2 v-if="deleteMut.isPending.value" class="h-3.5 w-3.5 mr-1.5 animate-spin" />
          Confirm delete
        </Button>
      </div>
    </div>
    <TicketBody :id-or-key="idOrKey" />
  </div>
</template>
