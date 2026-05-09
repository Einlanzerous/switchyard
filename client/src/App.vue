<script setup lang="ts">
import { computed, watch } from "vue";
import { useRoute, useRouter, RouterView } from "vue-router";
import AppShell from "@/components/layout/AppShell.vue";
import { Toaster } from "@/components/ui/sonner";
import { useAuthStore } from "@/stores/auth";

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();

// Login is the only chrome-less route for now. Anything else flagged
// `meta.public` would also bypass the shell.
const isBareRoute = computed(() => route.meta.public === true);

// Global handler: if the /me query returns 401 (revoked / expired token),
// drop the token and bounce to /login. Other API errors surface via Sonner
// from the QueryClient's mutation defaults; reads route through here.
watch(
  () => auth.error,
  (err) => {
    if (!err) return;
    const code = (err as { error?: { code?: string } }).error?.code;
    if (code === "unauthorized") {
      auth.logout();
      router.replace({ name: "login" });
    }
  }
);
</script>

<template>
  <RouterView v-if="isBareRoute" />
  <AppShell v-else />
  <Toaster :rich-colors="true" position="bottom-right" />
</template>
