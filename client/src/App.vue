<script setup lang="ts">
import { computed } from "vue";
import { useRoute } from "vue-router";
import AppShell from "@/components/layout/AppShell.vue";
import { Toaster } from "@/components/ui/sonner";
import { RouterView } from "vue-router";

// Login is the only chrome-less route for now. Everything else lives inside
// the AppShell (sidebar + topbar). Adding more bare routes (e.g. an auth
// callback page) means adding their paths here.
const route = useRoute();
const isBareRoute = computed(() => route.path === "/login");
</script>

<template>
  <RouterView v-if="isBareRoute" />
  <AppShell v-else />
  <Toaster :rich-colors="true" position="bottom-right" />
</template>
