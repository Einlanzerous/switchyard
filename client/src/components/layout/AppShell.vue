<script setup lang="ts">
import { RouterView } from "vue-router";
import AppSidebar from "./AppSidebar.vue";
import AppTopbar from "./AppTopbar.vue";
</script>

<template>
  <div class="min-h-screen flex bg-background text-foreground">
    <AppSidebar />
    <div class="flex flex-1 flex-col min-w-0">
      <AppTopbar />
      <main class="flex-1 overflow-auto">
        <RouterView />
      </main>
    </div>
  </div>
</template>
