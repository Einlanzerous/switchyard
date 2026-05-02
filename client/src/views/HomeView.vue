<script setup lang="ts">
import { ref, onMounted } from "vue";

const health = ref<{ status: string; db: boolean } | null>(null);
const error = ref<string | null>(null);

onMounted(async () => {
  try {
    const res = await fetch("/healthz");
    health.value = await res.json();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
});
</script>

<template>
  <main class="container py-12">
    <h1 class="text-4xl font-bold tracking-tight">switchyard</h1>
    <p class="mt-2 text-muted-foreground">
      Phase 0 scaffold. UI lands in Phase 2.
    </p>

    <section class="mt-8 rounded-lg border p-6">
      <h2 class="text-lg font-semibold">API health</h2>
      <p v-if="health" class="mt-2 font-mono text-sm">
        status: {{ health.status }} &middot; db: {{ health.db }}
      </p>
      <p v-else-if="error" class="mt-2 font-mono text-sm text-destructive">
        {{ error }}
      </p>
      <p v-else class="mt-2 font-mono text-sm text-muted-foreground">checking…</p>
    </section>

    <section class="mt-4 rounded-lg border p-6">
      <h2 class="text-lg font-semibold">API contract</h2>
      <p class="mt-2 text-sm text-muted-foreground">
        OpenAPI document at
        <a href="/v1/openapi.json" class="underline">/v1/openapi.json</a>.
      </p>
    </section>
  </main>
</template>
