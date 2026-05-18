// Project-related MCP tools. Small surface: list (for routing decisions)
// and get-statuses (needed before transitioning a ticket, since transitions
// reference status IDs that are project-scoped).

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getClient } from "../client.js";

export function registerProjectTools(server: McpServer): void {
  server.registerTool(
    "list_projects",
    {
      title: "List projects",
      description:
        "Return all projects in switchyard. Use this when you need to figure out " +
        "which project a ticket belongs in, or to discover the canonical project " +
        "key for routing. Each project has a short uppercase `key` (e.g. SWY, LOOP) " +
        "and a human name. Pass `include_archived=true` to also see archived projects.",
      inputSchema: {
        include_archived: z
          .boolean()
          .optional()
          .describe("Include archived projects in the result. Default: false."),
      },
    },
    async ({ include_archived }) => {
      const client = getClient();
      const { data, error } = await client.GET("/v1/projects", {
        params: {
          query: {
            include_archived: include_archived ?? false,
            limit: 200,
          },
        },
      });
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
}

// Switchyard's error envelope is `{ error: { code, message, details? } }`.
// Surface the message; agents can act on it.
function formatApiError(err: unknown): string {
  const e = err as { error?: { code?: string; message?: string } };
  const code = e?.error?.code ?? "unknown_error";
  const message = e?.error?.message ?? "(no message)";
  return `switchyard error [${code}]: ${message}`;
}
