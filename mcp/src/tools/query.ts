// Composed/sugar MCP tools — workflows shaped specifically for common
// agent intents that would otherwise require multiple primitive calls.

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getClient } from "../client.js";
import { formatApiError } from "../errors.js";

export function registerQueryTools(server: McpServer): void {
  server.registerTool(
    "query_my_open",
    {
      title: "Query my open tickets",
      description:
        "Return tickets assigned to the actor owning this MCP server's token that are " +
        "not in a `closed`-category status. Sugar over `list_tickets`: resolves `me` via " +
        "the /users/me endpoint, then filters the assignee's tickets to open-category " +
        "statuses. " +
        "Use this when an agent asks 'what's on my plate' or 'what should I work on " +
        "next' — it's pre-shaped for that intent and saves a round trip. " +
        "Optionally pass `project` to scope to one project. Results are sorted by " +
        "`updated_at desc` for recency.",
      inputSchema: {
        project: z
          .string()
          .optional()
          .describe("Optional project key (e.g. `SWY`) to scope results."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe("Page size, 1–200. Default 50."),
      },
    },
    async ({ project, limit }) => {
      const client = getClient();

      const meResp = await client.GET("/v1/users/me");
      if (meResp.error) {
        return {
          isError: true,
          content: [{ type: "text", text: formatApiError(meResp.error) }],
        };
      }
      const userId = meResp.data?.id;
      if (!userId) {
        return {
          isError: true,
          content: [{ type: "text", text: "switchyard error: /users/me returned no id" }],
        };
      }

      const ticketsResp = await client.GET("/v1/tickets", {
        params: {
          query: {
            assignee: userId,
            project,
            limit,
            sort_by: "updated_at",
            sort_order: "desc",
          },
        },
      });
      if (ticketsResp.error) {
        return {
          isError: true,
          content: [{ type: "text", text: formatApiError(ticketsResp.error) }],
        };
      }

      // Negation isn't expressible in the list endpoint's `status` filter
      // (single string only), so filter closed tickets out client-side.
      const open = (ticketsResp.data?.items ?? []).filter(
        (t) => t.status.category !== "closed",
      );

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ items: open, count: open.length }, null, 2),
          },
        ],
      };
    },
  );
}
