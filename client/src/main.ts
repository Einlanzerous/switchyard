import { createApp } from "vue";
import { createPinia } from "pinia";
import { VueQueryPlugin } from "@tanstack/vue-query";
import App from "./App.vue";
import { router } from "./router.js";
import { createAppQueryClient } from "./lib/queryClient.js";
import "./style.css";

createApp(App)
  .use(createPinia())
  .use(router)
  .use(VueQueryPlugin, { queryClient: createAppQueryClient() })
  .mount("#app");
