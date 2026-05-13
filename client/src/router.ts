import { createRouter, createWebHistory } from "vue-router";
import HomeView from "./views/HomeView.vue";
import LoginView from "./views/LoginView.vue";
import TicketsView from "./views/TicketsView.vue";
import TicketDetailView from "./views/TicketDetailView.vue";
import ProjectBoardView from "./views/ProjectBoardView.vue";
import BoardsListView from "./views/BoardsListView.vue";
import BoardView from "./views/BoardView.vue";
import BoardInsightsView from "./views/BoardInsightsView.vue";
import ProjectsView from "./views/ProjectsView.vue";
import ProjectInsightsView from "./views/ProjectInsightsView.vue";
import HealthView from "./views/HealthView.vue";

// Settings is a nested layout so each sub-section is its own route while
// sharing the sidebar. /settings on its own redirects to the profile page.
import SettingsLayout from "./views/settings/SettingsLayout.vue";
import SettingsProfile from "./views/settings/SettingsProfile.vue";
import SettingsTokens from "./views/settings/SettingsTokens.vue";
import SettingsLabels from "./views/settings/SettingsLabels.vue";
import SettingsProjects from "./views/settings/SettingsProjects.vue";
import SettingsProject from "./views/settings/SettingsProject.vue";
import SettingsProjectStatuses from "./views/settings/SettingsProjectStatuses.vue";
import SettingsProjectTransitions from "./views/settings/SettingsProjectTransitions.vue";
import SettingsUsers from "./views/settings/SettingsUsers.vue";
import SettingsCustomFields from "./views/settings/SettingsCustomFields.vue";

// Automations is its own top-level area; webhooks (and Phase-4 rules) live
// under it rather than under /settings, since they're a primary integration
// surface, not admin chrome.
import AutomationsLayout from "./views/automations/AutomationsLayout.vue";
import AutomationsWebhooks from "./views/automations/AutomationsWebhooks.vue";
import AutomationsWebhookDeliveries from "./views/automations/AutomationsWebhookDeliveries.vue";
import AutomationsRules from "./views/automations/AutomationsRules.vue";
import AutomationsRuleFirings from "./views/automations/AutomationsRuleFirings.vue";
import AutomationsTargets from "./views/automations/AutomationsTargets.vue";

import { getStoredToken } from "./lib/api.js";

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/login", name: "login", component: LoginView, meta: { public: true } },
    { path: "/", name: "home", component: HomeView },

    { path: "/tickets", name: "tickets", component: TicketsView },
    { path: "/tickets/:idOrKey", name: "ticket", component: TicketDetailView },
    { path: "/boards", name: "boards", component: BoardsListView },
    { path: "/boards/:id", name: "board", component: BoardView },
    { path: "/boards/:id/insights", name: "board-insights", component: BoardInsightsView },
    { path: "/projects", name: "projects", component: ProjectsView },
    { path: "/projects/:key/board", name: "project-board", component: ProjectBoardView },
    { path: "/projects/:key/insights", name: "project-insights", component: ProjectInsightsView },
    { path: "/health", name: "health", component: HealthView },

    {
      path: "/settings",
      component: SettingsLayout,
      redirect: "/settings/profile",
      children: [
        { path: "profile", name: "settings-profile", component: SettingsProfile },
        { path: "tokens", name: "settings-tokens", component: SettingsTokens },
        { path: "labels", name: "settings-labels", component: SettingsLabels },
        { path: "projects", name: "settings-projects", component: SettingsProjects },
        { path: "projects/:key", name: "settings-project", component: SettingsProject },
        {
          path: "projects/:key/statuses",
          name: "settings-project-statuses",
          component: SettingsProjectStatuses,
        },
        {
          path: "projects/:key/transitions",
          name: "settings-project-transitions",
          component: SettingsProjectTransitions,
        },
        { path: "users", name: "settings-users", component: SettingsUsers },
        { path: "custom-fields", name: "settings-custom-fields", component: SettingsCustomFields },
      ],
    },

    {
      path: "/automations",
      component: AutomationsLayout,
      redirect: "/automations/webhooks",
      children: [
        { path: "webhooks", name: "automations-webhooks", component: AutomationsWebhooks },
        {
          path: "webhooks/:id/deliveries",
          name: "automations-webhook-deliveries",
          component: AutomationsWebhookDeliveries,
        },
        { path: "rules", name: "automations-rules", component: AutomationsRules },
        {
          path: "rules/:id/firings",
          name: "automations-rule-firings",
          component: AutomationsRuleFirings,
        },
        { path: "targets", name: "automations-targets", component: AutomationsTargets },
      ],
    },
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
