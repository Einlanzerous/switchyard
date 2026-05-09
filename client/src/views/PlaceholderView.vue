<script setup lang="ts">
import { useRoute } from "vue-router";
import { computed } from "vue";
import { Construction } from "lucide-vue-next";
import { Card, CardContent } from "@/components/ui/card";

const route = useRoute();
const milestone = computed(() => (route.meta.milestone as string) ?? "Phase 2");
</script>

<template>
  <div class="container py-10 max-w-3xl">
    <Card>
      <CardContent class="flex flex-col items-center text-center gap-3 py-12">
        <Construction class="h-8 w-8 text-muted-foreground" />
        <div>
          <h2 class="text-lg font-semibold">{{ String(route.name ?? route.path) }}</h2>
          <p class="text-sm text-muted-foreground">
            Lands in milestone {{ milestone }}.
          </p>
        </div>
      </CardContent>
    </Card>
  </div>
</template>
