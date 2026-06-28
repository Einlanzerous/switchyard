import type { OpenAPIHono } from "@hono/zod-openapi";
import * as users from "./users.js";
import * as projects from "./projects.js";
import * as projectMembers from "./projectMembers.js";
import * as statuses from "./statuses.js";
import * as labels from "./labels.js";
import * as tickets from "./tickets.js";
import * as comments from "./comments.js";
import * as plans from "./plans.js";
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
import * as customFields from "./customFields.js";
import * as ticketExternalRefs from "./ticketExternalRefs.js";
import * as external from "./external.js";
import * as ticketTemplates from "./ticketTemplates.js";
import * as llmObservations from "./llmObservations.js";
import * as llmInsights from "./llmInsights.js";

export function mountRoutes(app: OpenAPIHono) {
  users.mount(app);
  projects.mount(app);
  // After projects.mount so the `/v1/projects/*` requireAuth+idempotency
  // wildcard is registered first (Hono runs middleware in registration order).
  projectMembers.mount(app);
  statuses.mount(app);
  labels.mount(app);
  tickets.mount(app);
  comments.mount(app);
  // After tickets.mount so the `/v1/tickets/*` requireAuth + idempotency
  // wildcards are registered first (plan routes live under /v1/tickets/*).
  plans.mount(app);
  attachments.mount(app);
  boards.mount(app);
  webhooks.mount(app);
  events.mount(app);
  settings.mount(app);
  stats.mount(app);
  // After stats.mount so the `/v1/stats/*` requireAuth wildcard is registered
  // first — llmInsights routes live under /v1/stats/llm/* and rely on it.
  llmInsights.mount(app);
  savedViews.mount(app);
  rules.mount(app);
  targets.mount(app);
  ticketLinks.mount(app);
  customFields.mount(app);
  ticketExternalRefs.mount(app);
  external.mount(app);
  ticketTemplates.mount(app);
  llmObservations.mount(app);
}
