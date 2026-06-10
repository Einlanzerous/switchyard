<script setup lang="ts">
// The one-time "copy your token now" banner. Renders the freshly-minted
// plaintext bearer plus a scannable QR (a `${origin}/login?token=…` URL so a
// phone's native scanner opens the browser pre-filled — SWY-63) and a Copy
// button. Owns its own QR generation so every mint surface (self tokens,
// admin-minted invite tokens) gets identical behaviour for free. The plaintext
// lives only in props for the lifetime of the dialog; closing forgets it.
//
// When an `message` is supplied (the invite flow), a copyable Discord-ready
// blurb is shown first — it already embeds the login link, so the raw token +
// QR below are the "or share directly" fallback.
import { ref, watch } from "vue";
import QRCode from "qrcode";
import { AlertTriangle, Copy } from "lucide-vue-next";
import { toast } from "vue-sonner";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";

const props = defineProps<{ token: string; name: string; message?: string }>();

const qrCodeUrl = ref<string | null>(null);

watch(
  () => props.token,
  async (token) => {
    qrCodeUrl.value = null;
    if (!token) return;
    const loginUrl = `${window.location.origin}/login?token=${encodeURIComponent(token)}`;
    qrCodeUrl.value = await QRCode.toDataURL(loginUrl, {
      errorCorrectionLevel: "M",
      margin: 2,
      width: 256,
      color: { dark: "#000000", light: "#ffffff" },
    });
  },
  { immediate: true },
);

async function copyText(text: string, label: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(`${label} copied`);
  } catch {
    toast.error("Couldn't copy — select and copy manually");
  }
}

defineExpose({ copy: () => copyText(props.token, "Token") });
</script>

<template>
  <div>
    <DialogHeader>
      <DialogTitle class="flex items-center gap-2">
        <AlertTriangle class="h-4 w-4 text-amber-500" />
        Copy {{ message ? "the invite" : "your token" }} now
      </DialogTitle>
      <DialogDescription>
        "{{ name }}" was created. The plaintext is shown once — after closing
        this dialog, only the hashed value remains.
      </DialogDescription>
    </DialogHeader>

    <!-- Invite message: a ready-to-paste blurb that already embeds the login link. -->
    <div v-if="message" class="space-y-1.5">
      <Label>Invite message <span class="font-normal text-muted-foreground">— paste into Discord</span></Label>
      <textarea
        :value="message"
        readonly
        rows="6"
        class="w-full rounded-md border bg-muted/40 px-3 py-2 text-xs font-mono resize-none focus:outline-none focus:ring-1 focus:ring-ring"
        @focus="(e) => (e.target as HTMLTextAreaElement).select()"
      />
      <Button class="w-full" @click="copyText(message, 'Invite message')">
        <Copy class="h-3.5 w-3.5 mr-1.5" /> Copy invite message
      </Button>
    </div>

    <!-- Raw token + QR — primary when there's no invite message, fallback otherwise. -->
    <div :class="message ? 'mt-4 pt-4 border-t space-y-2' : 'space-y-2'">
      <p v-if="message" class="text-[11px] text-muted-foreground">
        Or share the token / QR directly:
      </p>
      <div class="rounded-md border bg-muted/40 p-3 font-mono text-xs break-all">
        {{ token }}
      </div>
      <div v-if="qrCodeUrl" class="flex flex-col items-center gap-2">
        <div class="rounded-md bg-white p-2">
          <img :src="qrCodeUrl" alt="QR code encoding the new token" class="w-40 h-40 block" />
        </div>
        <p class="text-[11px] text-muted-foreground text-center">
          Scan from <code class="font-mono">/login</code> on another device.
        </p>
      </div>
      <button
        type="button"
        class="inline-flex items-center text-xs text-muted-foreground hover:text-foreground transition-colors"
        @click="copyText(token, 'Token')"
      >
        <Copy class="h-3.5 w-3.5 mr-1.5" /> Copy token
      </button>
    </div>
  </div>
</template>
