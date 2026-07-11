<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, useTemplateRef, computed, watch, nextTick } from "vue";
import { useRouter, useRoute } from "vue-router";
import { useQueryClient } from "@tanstack/vue-query";
import { Loader2, KeyRound, QrCode, Camera, X, ChevronRight } from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { api, setStoredToken, getStoredToken } from "@/lib/api";
import { queryKeys } from "@/lib/queryKeys";

// BarcodeDetector isn't in lib.dom yet. Minimal shape for the calls we make.
declare global {
  interface Window {
    BarcodeDetector?: {
      new (opts?: { formats?: string[] }): {
        detect: (source: CanvasImageSource) => Promise<Array<{ rawValue: string }>>;
      };
    };
  }
}

const router = useRouter();
const route = useRoute();
const queryClient = useQueryClient();

const mode = ref<"paste" | "scan">("paste");

const token = ref("");
const error = ref<string | null>(null);
const submitting = ref(false);

// Cloudflare Access SSO (SWY-161). On mount, when there's no stored token, we
// silently try to exchange the tunnel-injected Access JWT for a token. Through
// the tunnel this succeeds and the user never sees the form; on LAN/dev the
// endpoint 401s instantly and we fall back to the paste form.
const checkingSso = ref(false);
const ssoNoAccountEmail = ref<string | null>(null);
// First-boot bootstrap instructions live behind a disclosure so they stop
// greeting every visitor (they only matter to the operator standing up a server).
const showFirstBoot = ref(false);
// shadcn-vue Input is a thin wrapper, so the template ref resolves to the
// component instance, not the native <input>. `$el` is the rendered root
// element (the actual <input>). The chained optional calls keep this safe
// if the wrapper structure ever changes.
const inputEl = useTemplateRef<{ $el?: HTMLInputElement } | null>("inputEl");

const scanSupported = computed(
  () => typeof window !== "undefined" && "BarcodeDetector" in window,
);

const videoEl = useTemplateRef<HTMLVideoElement>("videoEl");
const scanError = ref<string | null>(null);
let stream: MediaStream | null = null;
let detectTimer: number | null = null;

onMounted(() => {
  // QR codes minted in /settings/tokens encode `${origin}/login?token=...`
  // so a phone's native scanner can hand-off into this view with the
  // bearer pre-filled. Strip the param from the URL on submit so it isn't
  // left in browser history.
  const fromQuery = typeof route.query.token === "string" ? route.query.token : null;
  if (fromQuery) {
    token.value = fromQuery;
    const { token: _drop, ...rest } = route.query;
    router.replace({ path: route.path, query: rest });
    submit();
    return;
  }
  // No token in hand → try Cloudflare Access SSO before showing the form.
  // (The router guard already keeps token-holders off /login, so the
  // stored-token check is belt-and-braces.)
  if (!getStoredToken()) {
    attemptSso();
    return;
  }
  inputEl.value?.$el?.focus?.();
});

async function attemptSso() {
  checkingSso.value = true;
  // openapi-fetch: no Authorization header is set (none stored), so the tunnel
  // header is what the server verifies. On LAN this returns 401 sso_disabled.
  const { data, error: apiError } = await api.POST("/v1/auth/sso/cloudflare");
  checkingSso.value = false;

  if (data?.token) {
    setStoredToken(data.token);
    // Seed /me so the auth store skips a roundtrip, mirroring submit().
    queryClient.setQueryData(queryKeys.usersMe(), data.user);
    const next = (route.query.next as string) || "/";
    router.replace(next);
    return;
  }

  const err = (apiError as any)?.error;
  if (err?.code === "sso_no_account") {
    // Verified by Cloudflare but no matching switchyard account — name the
    // email so the user knows exactly what to ask the admin for.
    ssoNoAccountEmail.value = typeof err?.details?.email === "string" ? err.details.email : null;
  }
  // Any other outcome (sso_disabled, unauthorized, network) → plain form.
  await nextTick();
  inputEl.value?.$el?.focus?.();
}
onBeforeUnmount(stopScan);

// Accept either a raw token string or a full /login?token=... URL — the
// latter is what gets minted by SettingsTokens today. Falls through to the
// raw value for any other shape so an older QR (pre-URL-wrapping) still works.
function extractToken(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return trimmed;
  try {
    const url = new URL(trimmed);
    const t = url.searchParams.get("token");
    if (t) return t;
  } catch {
    // not a URL — fall through
  }
  return trimmed;
}

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

async function startScan() {
  scanError.value = null;
  if (!window.BarcodeDetector) {
    scanError.value = "Your browser doesn't support QR scanning.";
    return;
  }
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment" },
      audio: false,
    });
    if (videoEl.value) {
      videoEl.value.srcObject = stream;
      await videoEl.value.play();
    }
    const detector = new window.BarcodeDetector({ formats: ["qr_code"] });
    detectTimer = window.setInterval(async () => {
      if (!videoEl.value || videoEl.value.readyState < 2) return;
      try {
        const codes = await detector.detect(videoEl.value);
        const value = codes[0]?.rawValue;
        if (value) {
          token.value = extractToken(value);
          stopScan();
          mode.value = "paste";
          submit();
        }
      } catch {
        // BarcodeDetector occasionally throws while the video is warming up — swallow and retry.
      }
    }, 200);
  } catch (e: any) {
    scanError.value = e?.message ?? "Couldn't access the camera.";
  }
}

function stopScan() {
  if (detectTimer !== null) {
    window.clearInterval(detectTimer);
    detectTimer = null;
  }
  if (stream) {
    for (const track of stream.getTracks()) track.stop();
    stream = null;
  }
  if (videoEl.value) videoEl.value.srcObject = null;
}

watch(mode, (m) => {
  if (m === "scan") startScan();
  else stopScan();
});
</script>

<template>
  <div class="min-h-screen flex items-center justify-center bg-background px-4">
    <Card class="w-full max-w-md">
      <CardHeader class="space-y-2 text-center">
        <div class="mx-auto h-10 w-10 rounded-md bg-primary flex items-center justify-center">
          <KeyRound class="h-5 w-5 text-primary-foreground" />
        </div>
        <CardTitle class="text-2xl">Sign in to switchyard</CardTitle>
        <CardDescription>
          {{
            mode === "scan"
              ? "Point your camera at a QR code from Settings → API tokens."
              : "Paste an API token to continue — or you'll be signed in automatically through Cloudflare."
          }}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div
          v-if="checkingSso"
          class="flex flex-col items-center justify-center gap-2 py-8 text-sm text-muted-foreground"
        >
          <Loader2 class="h-5 w-5 animate-spin" />
          Checking sign-in…
        </div>
        <template v-else>
          <p
            v-if="ssoNoAccountEmail"
            class="mb-3 rounded-md border border-border bg-muted/40 p-3 text-sm text-muted-foreground"
            role="alert"
          >
            You're signed in to Cloudflare as
            <span class="font-medium text-foreground">{{ ssoNoAccountEmail }}</span>, but no
            switchyard account has that email. Ask your admin to add it to your user — or paste a
            token below.
          </p>
          <form
            v-if="mode === 'paste'"
            class="space-y-3"
            @submit.prevent="submit"
          >
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
            <Button
              v-if="scanSupported"
              type="button"
              variant="ghost"
              class="w-full"
              @click="mode = 'scan'"
            >
              <QrCode class="h-4 w-4 mr-2" /> Scan QR instead
            </Button>
          </form>
          <div v-else class="space-y-3">
            <div class="relative aspect-square rounded-md overflow-hidden bg-black">
              <video
                ref="videoEl"
                class="absolute inset-0 w-full h-full object-cover"
                autoplay
                muted
                playsinline
              />
              <div class="absolute inset-6 border-2 border-white/40 rounded-md pointer-events-none" />
            </div>
            <p v-if="scanError" class="text-sm text-destructive" role="alert">
              {{ scanError }}
            </p>
            <p v-else class="text-xs text-muted-foreground text-center inline-flex items-center justify-center w-full">
              <Camera class="h-3 w-3 mr-1" />
              Scanning… hold steady on the code.
            </p>
            <Button
              type="button"
              variant="ghost"
              class="w-full"
              @click="mode = 'paste'"
            >
              <X class="h-4 w-4 mr-2" /> Cancel
            </Button>
          </div>
        </template>
      </CardContent>
      <CardFooter v-if="!checkingSso" class="flex-col items-start gap-2 text-xs text-muted-foreground">
        <button
          type="button"
          class="inline-flex items-center gap-1 hover:text-foreground transition-colors"
          :aria-expanded="showFirstBoot"
          @click="showFirstBoot = !showFirstBoot"
        >
          <ChevronRight
            class="h-3 w-3 transition-transform"
            :class="showFirstBoot && 'rotate-90'"
          />
          First time setting up this server?
        </button>
        <p v-if="showFirstBoot">
          On first boot the bootstrap token is printed to <code class="font-mono">docker logs switchyard</code>
          and written to <code class="font-mono">/data/uploads/.bootstrap-token</code> inside the container.
        </p>
      </CardFooter>
    </Card>
  </div>
</template>
