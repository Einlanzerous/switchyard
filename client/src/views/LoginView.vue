<script setup lang="ts">
import { ref, onMounted, useTemplateRef } from "vue";
import { useRouter, useRoute } from "vue-router";
import { useQueryClient } from "@tanstack/vue-query";
import { Loader2, KeyRound } from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { api, setStoredToken } from "@/lib/api";
import { queryKeys } from "@/lib/queryKeys";

const router = useRouter();
const route = useRoute();
const queryClient = useQueryClient();

const token = ref("");
const error = ref<string | null>(null);
const submitting = ref(false);
// shadcn-vue Input is a thin wrapper, so the template ref resolves to the
// component instance, not the native <input>. `$el` is the rendered root
// element (the actual <input>). The chained optional calls keep this safe
// if the wrapper structure ever changes.
const inputEl = useTemplateRef<{ $el?: HTMLInputElement } | null>("inputEl");

onMounted(() => inputEl.value?.$el?.focus?.());

async function submit() {
  const trimmed = token.value.trim();
  if (!trimmed) {
    error.value = "Token is required";
    return;
  }
  submitting.value = true;
  error.value = null;

  // Tentatively store the token so the api middleware attaches it on /me.
  setStoredToken(trimmed);

  const { data, error: apiError } = await api.GET("/v1/users/me");
  submitting.value = false;

  if (apiError || !data) {
    setStoredToken(null);
    const msg = (apiError as any)?.error?.message ?? "Token rejected";
    error.value = msg;
    return;
  }

  // Seed the cache so the auth store doesn't need a second roundtrip.
  queryClient.setQueryData(queryKeys.usersMe(), data);

  const next = (route.query.next as string) || "/";
  router.replace(next);
}
</script>

<template>
  <div class="min-h-screen flex items-center justify-center bg-background px-4">
    <Card class="w-full max-w-md">
      <CardHeader class="space-y-2 text-center">
        <div class="mx-auto h-10 w-10 rounded-md bg-primary flex items-center justify-center">
          <KeyRound class="h-5 w-5 text-primary-foreground" />
        </div>
        <CardTitle class="text-2xl">switchyard</CardTitle>
        <CardDescription>Paste an API token to continue.</CardDescription>
      </CardHeader>
      <CardContent>
        <form class="space-y-3" @submit.prevent="submit">
          <Input
            ref="inputEl"
            v-model="token"
            type="password"
            autocomplete="off"
            placeholder="sw_..."
            :disabled="submitting"
            spellcheck="false"
            class="font-mono text-sm"
          />
          <p
            v-if="error"
            class="text-sm text-destructive"
            role="alert"
          >
            {{ error }}
          </p>
          <Button type="submit" class="w-full" :disabled="submitting">
            <Loader2 v-if="submitting" class="h-4 w-4 mr-2 animate-spin" />
            {{ submitting ? "Verifying…" : "Log in" }}
          </Button>
        </form>
      </CardContent>
      <CardFooter class="text-xs text-muted-foreground">
        <p>
          On first boot the bootstrap token is printed to <code class="font-mono">docker logs switchyard</code>
          and written to <code class="font-mono">/data/uploads/.bootstrap-token</code> inside the container.
        </p>
      </CardFooter>
    </Card>
  </div>
</template>
