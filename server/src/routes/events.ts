import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { Event, EventType, ProjectKey, Iso8601, paginated, Pagination, Uuid } from "@switchyard/shared";
import { requireAuth } from "../auth.js";
import { errorResponses, okJson, stub, z } from "./_helpers.js";

const tag = "Events";

const list = createRoute({
  method: "get", path: "/v1/events", tags: [tag],
  summary: "Global event feed (audit log + chart source)",
  request: {
    query: Pagination.extend({
      project: ProjectKey.optional(),
      ticket_id: Uuid.optional(),
      actor_id: Uuid.optional(),
      event_type: z.string().optional(), // single or comma-separated
      since: Iso8601.optional(),
      until: Iso8601.optional(),
    }),
  },
  responses: { ...okJson(paginated(Event)), ...errorResponses },
});

export function mount(app: OpenAPIHono) {
  app.use("/v1/events/*", requireAuth);
  app.openapi(list, stub);
}
