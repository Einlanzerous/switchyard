// Typed cross-ticket relations (blocks / relates_to / duplicates).
// Wraps the same `ticket_links` endpoints the web UI uses; cross-project
// links are first-class on the underlying API and just pass through here.

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getClient } from "../client.js";
import { formatApiError } from "../errors.js";

const LINK_TYPE = z.enum(["blocks", "relates_to", "duplicates"]);

export function registerTicketLinkTools(server: McpServer): void {
  server.registerTool(
    "list_ticket_links",
    {
      title: "List ticket links",
      description:
        "Return every typed cross-ticket relation involving this ticket. Each row " +
        "carries `direction` — `outgoing` means this ticket is the source (e.g. " +
        "this ticket *blocks* the other), `incoming` means it's the target (the " +
        "other ticket blocks this one) — plus the relation `type` (`blocks` / " +
        "`relates_to` / `duplicates`), the `id` (UUID needed for `delete_ticket_link`), " +
        "and a compact `other_ticket` (`id`, `key`, `title`) so display needs no " +
        "follow-up fetch. **Cross-project links are first-class**: a `SWY-X blocks " +
        "LOOP-Y` row appears here whether you query SWY-X or LOOP-Y.",
      inputSchema: {
        id_or_key: z
          .string()
          .describe("Ticket key (e.g. `SWY-47`) or UUID."),
      },
    },
    async ({ id_or_key }) => {
      const client = getClient();
      const { data, error } = await client.GET(
        "/v1/tickets/{idOrKey}/links",
        { params: { path: { idOrKey: id_or_key } } },
      );
      if (error) {
        return {
          isError: true,
          content: [{ type: "text", text: formatApiError(error) }],
        };
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(data?.items ?? [], null, 2),
          },
        ],
      };
    },
  );

  server.registerTool(
    "create_ticket_link",
    {
      title: "Create ticket link",
      description:
        "Create a typed link from `source_id_or_key` to `target_id_or_key`. " +
        "Types: " +
        "`blocks` (asymmetric — source blocks target until target resolves), " +
        "`relates_to` (symmetric soft link — \"see also\"), " +
        "`duplicates` (asymmetric — source duplicates target; typical for triage " +
        "agents that find an existing equivalent). " +
        "**Cross-project links are first-class**: any combination of project keys " +
        "is valid (e.g. `source=SWY-42, target=LOOP-7`). " +
        "The unique constraint is `(source, target, type)` — re-creating the same " +
        "edge returns a 409 conflict with a clear message. Creating the inverse " +
        "edge (target→source, same type) is allowed and stored as a separate row. " +
        "Self-links (source === target) are rejected with `bad_request`.",
      inputSchema: {
        source_id_or_key: z
          .string()
          .describe("Source ticket key (e.g. `SWY-42`) or UUID."),
        target_id_or_key: z
          .string()
          .describe(
            "Target ticket key (e.g. `LOOP-7`) or UUID. May live in a different project.",
          ),
        type: LINK_TYPE.describe(
          "Link type: `blocks`, `relates_to`, or `duplicates`.",
        ),
      },
    },
    async ({ source_id_or_key, target_id_or_key, type }) => {
      const client = getClient();
      const { data, error } = await client.POST(
        "/v1/tickets/{idOrKey}/links",
        {
          params: { path: { idOrKey: source_id_or_key } },
          body: { type, target: target_id_or_key },
        },
      );
      if (error) {
        return {
          isError: true,
          content: [{ type: "text", text: formatApiError(error) }],
        };
      }
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      };
    },
  );

  server.registerTool(
    "delete_ticket_link",
    {
      title: "Delete ticket link",
      description:
        "Remove a typed cross-ticket relation by its `link_id` UUID (the `id` " +
        "field returned by `list_ticket_links`). Returns 204 on success. For " +
        "cross-project links, both projects emit a `ticket.link_removed` event " +
        "so rules and webhook subscriptions on either side react to the removal.",
      inputSchema: {
        link_id: z
          .string()
          .describe(
            "Link UUID from `list_ticket_links` (the `id` field on each row).",
          ),
      },
    },
    async ({ link_id }) => {
      const client = getClient();
      const { error } = await client.DELETE(
        "/v1/tickets/links/{id}",
        { params: { path: { id: link_id } } },
      );
      if (error) {
        return {
          isError: true,
          content: [{ type: "text", text: formatApiError(error) }],
        };
      }
      return {
        content: [{ type: "text", text: `deleted ticket link ${link_id}` }],
      };
    },
  );
}
