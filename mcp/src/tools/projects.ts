// Project-related MCP tools. Small surface: list (for routing decisions)
// and get-statuses (needed before transitioning a ticket, since transitions
// reference status IDs that are project-scoped).

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getClient } from "../client.js";
import { formatApiError } from "../errors.js";

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

  server.registerTool(
    "get_project_statuses",
    {
      title: "Get project statuses",
      description:
        "Return the ordered list of statuses defined on a project. Call this BEFORE " +
        "`transition_ticket` to discover the `status_id` you need to pass — status IDs " +
        "are project-scoped (different projects can have differently-named statuses with " +
        "different IDs even in the same category). Each status carries a `category` " +
        "(`backlog`/`planning`/`in_progress`/`blocked`/`closed`) which is the stable " +
        "machine-readable bucket; `display_name` is what users see and can vary per project.",
      inputSchema: {
        project_key: z
          .string()
          .describe("Project key (e.g. `SWY`, `LOOP`). Case-sensitive, uppercase."),
      },
    },
    async ({ project_key }) => {
      const client = getClient();
      const { data, error } = await client.GET("/v1/projects/{key}/statuses", {
        params: { path: { key: project_key } },
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

