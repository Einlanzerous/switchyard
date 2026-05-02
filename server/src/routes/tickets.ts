import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import {
  Ticket, TicketSummary, CreateTicket, UpdateTicket, TransitionTicket,
  TicketListFilters, Event, paginated, Pagination,
} from "@switchyard/shared";
import { requireAuth } from "../auth.js";
import { errorResponses, okJson, createdJson, noContent, stub, z, idempotencyHeader } from "./_helpers.js";

const tag = "Tickets";

// Path param accepts either a UUID or a project-prefixed key (e.g. SWY-47).
const idOrKey = z.string().min(1);

const list = createRoute({
  method: "get", path: "/v1/tickets", tags: [tag], summary: "List tickets",
  request: { query: TicketListFilters.merge(Pagination) },
  responses: { ...okJson(paginated(TicketSummary)), ...errorResponses },
});

const create = createRoute({
  method: "post", path: "/v1/tickets", tags: [tag], summary: "Create a ticket",
  request: {
    headers: idempotencyHeader,
    body: { content: { "application/json": { schema: CreateTicket } } },
  },
  responses: { ...createdJson(Ticket), ...errorResponses },
});

const get = createRoute({
  method: "get", path: "/v1/tickets/{idOrKey}", tags: [tag],
  summary: "Get a ticket by UUID or KEY (e.g. SWY-47)",
  request: { params: z.object({ idOrKey }) },
  responses: { ...okJson(Ticket), ...errorResponses },
});

const update = createRoute({
  method: "patch", path: "/v1/tickets/{idOrKey}", tags: [tag], summary: "Update a ticket",
  request: {
    params: z.object({ idOrKey }),
    headers: idempotencyHeader,
    body: { content: { "application/json": { schema: UpdateTicket } } },
  },
  responses: { ...okJson(Ticket), ...errorResponses },
});

const remove = createRoute({
  method: "delete", path: "/v1/tickets/{idOrKey}", tags: [tag], summary: "Soft-delete a ticket",
  request: { params: z.object({ idOrKey }) },
  responses: { ...noContent, ...errorResponses },
});

const transition = createRoute({
  method: "post", path: "/v1/tickets/{idOrKey}/transition", tags: [tag],
  summary: "Move a ticket to a new status (validates transitions table + epic guard)",
  request: {
    params: z.object({ idOrKey }),
    headers: idempotencyHeader,
    body: { content: { "application/json": { schema: TransitionTicket } } },
  },
  responses: { ...okJson(Ticket), ...errorResponses },
});

const events = createRoute({
  method: "get", path: "/v1/tickets/{idOrKey}/events", tags: [tag], summary: "Audit history for a ticket",
  request: { params: z.object({ idOrKey }), query: Pagination },
  responses: { ...okJson(paginated(Event)), ...errorResponses },
});

const children = createRoute({
  method: "get", path: "/v1/tickets/{idOrKey}/children", tags: [tag],
  summary: "List child tickets (for an epic)",
  request: { params: z.object({ idOrKey }), query: Pagination },
  responses: { ...okJson(paginated(TicketSummary)), ...errorResponses },
});

export function mount(app: OpenAPIHono) {
  app.use("/v1/tickets/*", requireAuth);
  app.openapi(list, stub);
  app.openapi(create, stub);
  app.openapi(get, stub);
  app.openapi(update, stub);
  app.openapi(remove, stub);
  app.openapi(transition, stub);
  app.openapi(events, stub);
  app.openapi(children, stub);
}
