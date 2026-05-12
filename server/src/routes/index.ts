import type { OpenAPIHono } from "@hono/zod-openapi";
import * as users from "./users.js";
import * as projects from "./projects.js";
import * as statuses from "./statuses.js";
import * as labels from "./labels.js";
import * as tickets from "./tickets.js";
import * as comments from "./comments.js";
import * as attachments from "./attachments.js";
import * as boards from "./boards.js";
import * as webhooks from "./webhooks.js";
import * as events from "./events.js";
import * as settings from "./settings.js";
import * as stats from "./stats.js";
import * as savedViews from "./savedViews.js";
import * as rules from "./rules.js";
import * as targets from "./targets.js";
import * as ticketLinks from "./ticketLinks.js";

export function mountRoutes(app: OpenAPIHono) {
  users.mount(app);
  projects.mount(app);
  statuses.mount(app);
  labels.mount(app);
  tickets.mount(app);
  comments.mount(app);
  attachments.mount(app);
  boards.mount(app);
  webhooks.mount(app);
  events.mount(app);
  settings.mount(app);
  stats.mount(app);
  savedViews.mount(app);
  rules.mount(app);
  targets.mount(app);
  ticketLinks.mount(app);
}
