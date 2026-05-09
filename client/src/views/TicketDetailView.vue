<script setup lang="ts">
import { computed } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ArrowLeft } from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import TicketBody from "@/components/tickets/TicketBody.vue";

const route = useRoute();
const router = useRouter();

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
</script>

<template>
  <div class="container max-w-3xl py-8">
    <Button variant="ghost" size="sm" class="mb-4 -ml-2 text-muted-foreground" @click="back">
      <ArrowLeft class="h-3.5 w-3.5 mr-1.5" /> Back
    </Button>
    <TicketBody :id-or-key="idOrKey" />
  </div>
</template>
