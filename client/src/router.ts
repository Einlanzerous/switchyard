import { createRouter, createWebHistory } from "vue-router";
import HomeView from "./views/HomeView.vue";

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", name: "home", component: HomeView },
    // Phase 2 will add: /tickets, /tickets/:key, /boards, /boards/:id, /projects, /settings
  ],
});
