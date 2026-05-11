import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { fileURLToPath, URL } from "node:url";

// Dev-server proxy target. Defaults to the deployed backend at :4002 (the
// way the user runs local dev), but CI overrides this so the E2E suite
// can talk to a backend booted against switchyard_test rather than the
// shared deployed instance reading prod data. See .github/workflows/e2e.yml.
const apiProxyTarget = process.env.VITE_API_PROXY_TARGET ?? "http://localhost:4002";

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
