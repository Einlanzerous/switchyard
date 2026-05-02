import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import {
  WebhookSubscription, WebhookSubscriptionWithSecret,
  CreateWebhookSubscription, UpdateWebhookSubscription,
  WebhookDelivery, Uuid, paginated, Pagination,
} from "@switchyard/shared";
import { requireAuth, requireScope } from "../auth.js";
import { errorResponses, okJson, createdJson, noContent, stub, z } from "./_helpers.js";

const tag = "Webhooks";

const list = createRoute({
  method: "get", path: "/v1/webhooks", tags: [tag], summary: "List webhook subscriptions",
  request: { query: Pagination },
  responses: { ...okJson(paginated(WebhookSubscription)), ...errorResponses },
});

const create = createRoute({
  method: "post", path: "/v1/webhooks", tags: [tag],
  summary: "Create a webhook subscription (secret returned ONCE)",
  request: { body: { content: { "application/json": { schema: CreateWebhookSubscription } } } },
  responses: { ...createdJson(WebhookSubscriptionWithSecret), ...errorResponses },
});

const get = createRoute({
  method: "get", path: "/v1/webhooks/{id}", tags: [tag], summary: "Get a webhook subscription",
  request: { params: z.object({ id: Uuid }) },
  responses: { ...okJson(WebhookSubscription), ...errorResponses },
});

const update = createRoute({
  method: "patch", path: "/v1/webhooks/{id}", tags: [tag], summary: "Update a webhook subscription",
  request: {
    params: z.object({ id: Uuid }),
    body: { content: { "application/json": { schema: UpdateWebhookSubscription } } },
  },
  responses: { ...okJson(WebhookSubscription), ...errorResponses },
});

const remove = createRoute({
  method: "delete", path: "/v1/webhooks/{id}", tags: [tag], summary: "Delete a webhook subscription",
  request: { params: z.object({ id: Uuid }) },
  responses: { ...noContent, ...errorResponses },
});

const deliveries = createRoute({
  method: "get", path: "/v1/webhooks/{id}/deliveries", tags: [tag],
  summary: "Recent delivery attempts for a subscription (debugging)",
  request: { params: z.object({ id: Uuid }), query: Pagination },
  responses: { ...okJson(paginated(WebhookDelivery)), ...errorResponses },
});

const redeliver = createRoute({
  method: "post", path: "/v1/webhooks/deliveries/{id}/redeliver", tags: [tag],
  summary: "Re-attempt a delivery (queues a new attempt; returns the existing delivery row)",
  request: { params: z.object({ id: Uuid }) },
  responses: { ...okJson(WebhookDelivery), ...errorResponses },
});

export function mount(app: OpenAPIHono) {
  app.use("/v1/webhooks/*", requireAuth);
  app.openapi(list, stub);
  app.openapi(create, requireScope("webhooks:manage"), stub);
  app.openapi(get, stub);
  app.openapi(update, requireScope("webhooks:manage"), stub);
  app.openapi(remove, requireScope("webhooks:manage"), stub);
  app.openapi(deliveries, stub);
  app.openapi(redeliver, requireScope("webhooks:manage"), stub);
}
