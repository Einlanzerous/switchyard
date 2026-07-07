import { createApp } from "vue";
import { createPinia } from "pinia";
import { VueQueryPlugin } from "@tanstack/vue-query";
import App from "./App.vue";
import { router } from "./router.js";
import { createAppQueryClient } from "./lib/queryClient.js";
import { useThemeStore } from "./stores/theme.js";
import "@fontsource-variable/hanken-grotesk";
import "@fontsource-variable/jetbrains-mono";
import "./style.css";

const pinia = createPinia();
const app = createApp(App)
  .use(pinia)
  .use(router)
  .use(VueQueryPlugin, { queryClient: createAppQueryClient() });

// Instantiate the theme store eagerly: index.html ships `<html class="dark">`
// (dark-first FOUC guard) and useColorMode inside this store is the only
// thing that reconciles the class with the persisted preference. Before
// SWY-158 the store was only pulled in by chart widgets / settings, so a
// full page load on a chart-less view (Tickets, Board, Ticket detail)
// stayed dark regardless of the stored theme.
useThemeStore(pinia);

app.mount("#app");
