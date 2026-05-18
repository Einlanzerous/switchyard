import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { fileURLToPath, URL } from "node:url";

// Dev-server proxy target. Defaults to a locally-running backend on :4012
// (start it with `PORT=4012 bun run dev:server` pointed at switchyard_test
// so dev never writes to prod data). CI overrides this so the E2E suite can
// talk to its own backend; the deployed prod backend on :4002 can be
// targeted explicitly via `VITE_API_PROXY_TARGET=http://localhost:4002` when
// you need read-only debugging against live data.
const apiProxyTarget = process.env.VITE_API_PROXY_TARGET ?? "http://localhost:4012";

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/v1": apiProxyTarget,
      "/healthz": apiProxyTarget,
    },
  },
});
