// Project-related MCP tools. Surface: project + label discovery (list,
// get, statuses), and project creation. Status/transition mutation and
// label CRUD stay deferred — admin paths, not agent paths.

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getClient } from "../client.js";
import { formatApiError } from "../errors.js";

const PROJECT_KEY = z
  .string()
  .regex(
    /^[A-Z][A-Z0-9]{1,9}$/,
    "Project key must be 2–10 chars, uppercase alphanumeric, starting with a letter (e.g. `SWY`, `LOOP`).",
  );

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
    "get_project",
    {
      title: "Get project",
      description:
        "Fetch a single project by key. Useful before `create_project` to check " +
        "whether a key is already taken — calling `create_project` on an existing " +
        "key returns a 409 conflict. Returns the project metadata (name, description, " +
        "color, archived state, and the two pipeline-relevant fields `repo_url` and " +
        "`default_test_cmd` — the cogitation engine falls back to these when a ticket " +
        "lacks its own `metadata.repo_url` / `metadata.test_cmd`). For the project's " +
        "statuses, call `get_project_statuses` instead.",
      inputSchema: {
        project_key: PROJECT_KEY.describe(
          "Project key (e.g. `SWY`). Case-sensitive, uppercase.",
        ),
      },
    },
    async ({ project_key }) => {
      const client = getClient();
      const { data, error } = await client.GET("/v1/projects/{key}", {
        params: { path: { key: project_key } },
      });
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
    "create_project",
    {
      title: "Create project",
      description:
        "Create a new switchyard project. Call this once per repo / new initiative — " +
        "the project key is **immutable** after creation, so pick deliberately. " +
        "Convention: 2–10 uppercase alphanumeric chars starting with a letter, " +
        "matching the eventual ticket prefix you want (`LOOP-42`, `FLOW-7`, " +
        "`INCUBATOR-3`). " +
        "The project is automatically seeded with the canonical default statuses — " +
        "Backlog (default) / Planning / In Progress / Blocked / Closed — so no " +
        "follow-up `get_project_statuses` + status-creation calls are needed for " +
        "typical workflows. " +
        "Idempotency is on the caller: returns 409 on a duplicate key. Prefer " +
        "checking with `get_project` first when in doubt. " +
        "For pipeline-driven projects (one repo, one test command for every ticket), " +
        "set `repo_url` and `default_test_cmd` at creation — together they mark the " +
        "project as pipeline-ready and let the cogitation engine pick up tickets " +
        "without per-ticket `metadata.repo_url` / `metadata.test_cmd` backfill.",
      inputSchema: {
        key: PROJECT_KEY.describe(
          "Project key (immutable). 2–10 uppercase alphanumeric chars starting with a letter.",
        ),
        name: z
          .string()
          .min(1)
          .max(200)
          .describe("Human-readable project name."),
        description: z
          .string()
          .max(10_000)
          .optional()
          .describe("Markdown description of the project (optional)."),
        color: z
          .string()
          .regex(/^#[0-9a-fA-F]{6}$/)
          .optional()
          .describe("Hex color for UI accents, e.g. `#3b82f6`."),
        repo_url: z
          .string()
          .url()
          .max(2048)
          .optional()
          .describe(
            "Canonical repo URL — surfaces as a link from the project header, " +
            "and marks the project as pipeline-relevant (cogitation engine falls " +
            "back to it when a ticket lacks `metadata.repo_url`).",
          ),
        default_test_cmd: z
          .string()
          .max(2048)
          .optional()
          .describe(
            "Default shell command the pipeline runs for tickets in this project " +
            "(e.g. `bun test`). Tickets without their own `metadata.test_cmd` fall " +
            "back to this. Pair with `repo_url` to fully describe a pipeline-driven project.",
          ),
      },
    },
    async (input) => {
      const client = getClient();
      const { data, error } = await client.POST("/v1/projects", {
        body: input,
      });
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
    "list_labels",
    {
      title: "List labels",
      description:
        "Return the global label catalog. Labels are shared across projects in " +
        "switchyard, not per-project. Each label has an `id` (UUID), `name`, and " +
        "`color`. Use the UUIDs in `create_ticket.label_ids` or " +
        "`update_ticket.label_ids` to attach labels to a ticket. Label CRUD is not " +
        "exposed via MCP — manage them in the web UI.",
      inputSchema: {},
    },
    async () => {
      const client = getClient();
      const { data, error } = await client.GET("/v1/labels", {});
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

