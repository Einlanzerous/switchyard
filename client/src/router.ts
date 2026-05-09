import { createRouter, createWebHistory } from "vue-router";
import HomeView from "./views/HomeView.vue";
import LoginView from "./views/LoginView.vue";
import TicketsView from "./views/TicketsView.vue";
import PlaceholderView from "./views/PlaceholderView.vue";
import { getStoredToken } from "./lib/api.js";

// Placeholder routes are wired so the sidebar's RouterLinks resolve and the
// router doesn't warn at render time. Each placeholder advertises the milestone
// it'll be replaced in.
export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/login", name: "login", component: LoginView, meta: { public: true } },
    { path: "/", name: "home", component: HomeView },

    { path: "/tickets", name: "tickets", component: TicketsView },
    { path: "/tickets/:idOrKey", name: "ticket", component: PlaceholderView, meta: { milestone: "2.3" } },
    { path: "/boards", name: "boards", component: PlaceholderView, meta: { milestone: "2.5" } },
    { path: "/boards/:id", name: "board", component: PlaceholderView, meta: { milestone: "2.5" } },
    { path: "/projects", name: "projects", component: PlaceholderView, meta: { milestone: "2.6" } },
    { path: "/projects/:key/board", name: "project-board", component: PlaceholderView, meta: { milestone: "2.4" } },
    { path: "/settings", name: "settings", component: PlaceholderView, meta: { milestone: "2.6" } },
    { path: "/settings/:section", name: "settings-section", component: PlaceholderView, meta: { milestone: "2.6" } },
  ],
});

// Synchronous gate: presence of a token is enough to navigate. The auth store's
// /me query then verifies it; the global 401 handler in App.vue catches revoked
// tokens and re-routes back to /login. This keeps navigation responsive — no
// awaiting the verify roundtrip on every route change.
router.beforeEach((to) => {
  const hasToken = !!getStoredToken();

  if (to.meta.public) {
    if (hasToken && to.name === "login") return { name: "home" };
    return true;
  }

  if (!hasToken) {
    return { name: "login", query: to.fullPath !== "/" ? { next: to.fullPath } : {} };
  }

  return true;
});
