// Project-related MCP tools. Surface: project + status + label discovery,
// project creation, status enum admin (create / update / delete), and
// label CRUD. Status *transitions* (the allow-list of from→to edges) stay
// REST-only for now — they're rarely tuned and adding them here would
// triple the tool count without a concrete dogfooding pull.

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

const STATUS_CATEGORY = z.enum([
  "backlog",
  "planning",
  "in_progress",
  "blocked",
  "closed",
]);

const HEX_COLOR = z
  .string()
  .regex(
    /^#[0-9a-fA-F]{6}$/,
    "Color must be a 6-digit hex value with leading `#` (e.g. `#3b82f6`).",
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
    "update_project",
    {
      title: "Update project",
      description:
        "Update an existing project's mutable fields. The project `key` is " +
        "**immutable** and cannot be changed here — it only identifies which " +
        "project to update. Only the fields you pass are touched; omit a field to " +
        "leave it unchanged. For the nullable fields (`repo_url`, " +
        "`default_test_cmd`, `board_closed_window_days`) pass `null` to clear an " +
        "existing value and fall back to defaults. Use this to backfill a project " +
        "that was created with only a key + name, or to archive/unarchive it. " +
        "Returns 404 if the key doesn't exist, 409 on a conflicting change.",
      inputSchema: {
        project_key: PROJECT_KEY.describe(
          "Key of the project to update (immutable identifier, e.g. `ARGY`).",
        ),
        name: z
          .string()
          .min(1)
          .max(200)
          .optional()
          .describe("New human-readable project name."),
        description: z
          .string()
          .max(10_000)
          .optional()
          .describe("New markdown description."),
        color: z
          .string()
          .regex(/^#[0-9a-fA-F]{6}$/)
          .optional()
          .describe("New hex accent color, e.g. `#3b82f6`."),
        repo_url: z
          .string()
          .url()
          .max(2048)
          .nullable()
          .optional()
          .describe("New canonical repo URL. Pass `null` to clear the link."),
        default_test_cmd: z
          .string()
          .max(2048)
          .nullable()
          .optional()
          .describe("New default test command. Pass `null` to clear it."),
        archived: z
          .boolean()
          .optional()
          .describe("Set `true` to archive the project, `false` to unarchive."),
      },
    },
    async ({ project_key, ...body }) => {
      const client = getClient();
      const { data, error } = await client.PATCH("/v1/projects/{key}", {
        params: { path: { key: project_key } },
        body,
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
        "`update_ticket.label_ids` to attach labels to a ticket. For mutation, " +
        "see `create_label` / `update_label` / `delete_label`.",
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

  server.registerTool(
    "create_status",
    {
      title: "Create a status",
      description:
        "Add a new status to a project's pipeline. Statuses are project-scoped; " +
        "create one per `(project, display_name)`. `category` is the stable " +
        "machine-readable bucket (one of `backlog` / `planning` / `in_progress` / " +
        "`blocked` / `closed`) — multiple statuses can share a category. `position` " +
        "controls display order (lowest first); omit to append after the current " +
        "max. `is_default=true` marks the status that new tickets land on; setting " +
        "it true here flips the previous default off in the same transaction.",
      inputSchema: {
        project_key: PROJECT_KEY.describe("Project key (e.g. `SWY`, `LOOP`)."),
        category: STATUS_CATEGORY.describe(
          "Status category — the stable bucket. `closed` statuses also require a " +
          "`resolution` on transition; the other four don't.",
        ),
        display_name: z
          .string()
          .min(1)
          .max(50)
          .describe("Display name shown in the UI (1–50 chars). Must be unique within the project."),
        position: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Display order (lowest first). Omit to append after current max."),
        is_default: z
          .boolean()
          .optional()
          .describe(
            "If true, this status becomes the project's default (new tickets land here) " +
            "and the previous default is cleared in the same transaction.",
          ),
      },
    },
    async ({ project_key, category, display_name, position, is_default }) => {
      const client = getClient();
      const { data, error } = await client.POST(
        "/v1/projects/{key}/statuses",
        {
          params: { path: { key: project_key } },
          body: {
            category,
            display_name,
            ...(position !== undefined ? { position } : {}),
            ...(is_default !== undefined ? { is_default } : {}),
          },
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
    "update_status",
    {
      title: "Update a status",
      description:
        "Patch a status's `category`, `display_name`, `position`, or `is_default`. " +
        "Only supplied fields are touched. Setting `is_default=true` clears the " +
        "previous default in the same transaction. Pass `project_key` to scope the " +
        "lookup — the server rejects status IDs that don't belong to the project.",
      inputSchema: {
        project_key: PROJECT_KEY.describe("Project key the status belongs to."),
        status_id: z.string().describe("Status UUID (from `get_project_statuses`)."),
        category: STATUS_CATEGORY.optional().describe("New category."),
        display_name: z
          .string()
          .min(1)
          .max(50)
          .optional()
          .describe("New display name (1–50 chars, unique within the project)."),
        position: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("New display position."),
        is_default: z
          .boolean()
          .optional()
          .describe(
            "If true, makes this the project's default status and clears the previous default.",
          ),
      },
    },
    async ({ project_key, status_id, category, display_name, position, is_default }) => {
      const client = getClient();
      const { data, error } = await client.PATCH(
        "/v1/projects/{key}/statuses/{id}",
        {
          params: { path: { key: project_key, id: status_id } },
          body: {
            ...(category !== undefined ? { category } : {}),
            ...(display_name !== undefined ? { display_name } : {}),
            ...(position !== undefined ? { position } : {}),
            ...(is_default !== undefined ? { is_default } : {}),
          },
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
    "delete_status",
    {
      title: "Delete a status",
      description:
        "Permanently delete a status. The server refuses (422) if the status is " +
        "still referenced by any ticket — move those tickets first via " +
        "`transition_ticket` or `transition_ticket_by_category`. The project's " +
        "default status also cannot be deleted; promote another status to default " +
        "via `update_status` first.",
      inputSchema: {
        project_key: PROJECT_KEY.describe("Project key the status belongs to."),
        status_id: z.string().describe("Status UUID (from `get_project_statuses`)."),
      },
    },
    async ({ project_key, status_id }) => {
      const client = getClient();
      const { error } = await client.DELETE(
        "/v1/projects/{key}/statuses/{id}",
        { params: { path: { key: project_key, id: status_id } } },
      );
      if (error) {
        return {
          isError: true,
          content: [{ type: "text", text: formatApiError(error) }],
        };
      }
      return {
        content: [{ type: "text", text: `deleted status ${status_id}` }],
      };
    },
  );

  server.registerTool(
    "create_label",
    {
      title: "Create a label",
      description:
        "Add a label to the global label catalog. Labels are not project-scoped — " +
        "any ticket in any project can carry any subset of them. Names are unique " +
        "across the catalog (409 on duplicate). `color` is a 6-digit hex value with " +
        "leading `#` (e.g. `#3b82f6`). After creation, attach via `update_ticket.label_ids`.",
      inputSchema: {
        name: z
          .string()
          .min(1)
          .max(50)
          .describe("Label name (1–50 chars). Must be unique across the catalog."),
        color: HEX_COLOR.describe("Hex color for UI chips, e.g. `#3b82f6`."),
      },
    },
    async ({ name, color }) => {
      const client = getClient();
      const { data, error } = await client.POST("/v1/labels", {
        body: { name, color },
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
    "update_label",
    {
      title: "Update a label",
      description:
        "Rename a label or change its color. Only supplied fields are touched. " +
        "Renaming to a name already in use returns 409. Updates apply globally — " +
        "every ticket that already carries this label reflects the new name/color " +
        "immediately.",
      inputSchema: {
        label_id: z.string().describe("Label UUID (from `list_labels`)."),
        name: z
          .string()
          .min(1)
          .max(50)
          .optional()
          .describe("New name (1–50 chars). Must be unique across the catalog."),
        color: HEX_COLOR.optional().describe("New hex color, e.g. `#3b82f6`."),
      },
    },
    async ({ label_id, name, color }) => {
      const client = getClient();
      const { data, error } = await client.PATCH("/v1/labels/{id}", {
        params: { path: { id: label_id } },
        body: {
          ...(name !== undefined ? { name } : {}),
          ...(color !== undefined ? { color } : {}),
        },
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
    "delete_label",
    {
      title: "Delete a label",
      description:
        "Permanently delete a label. By default the server refuses (422) if any " +
        "ticket still carries the label — detach via `update_ticket.label_ids` " +
        "first, or pass `force=true` to delete anyway. With `force=true`, the FK " +
        "cascade strips the label from every referencing ticket as part of the " +
        "delete (destructive, no undo) — prefer the detach-first flow for any " +
        "label that has been around long enough that you're not sure who's using it.",
      inputSchema: {
        label_id: z.string().describe("Label UUID (from `list_labels`)."),
        force: z
          .boolean()
          .optional()
          .describe(
            "If true, delete even when the label is still attached to tickets — the " +
            "FK cascade removes the label from every referencing ticket. Default: false.",
          ),
      },
    },
    async ({ label_id, force }) => {
      const client = getClient();
      const { error } = await client.DELETE("/v1/labels/{id}", {
        params: {
          path: { id: label_id },
          query: force ? { force: "true" } : {},
        },
      });
      if (error) {
        return {
          isError: true,
          content: [{ type: "text", text: formatApiError(error) }],
        };
      }
      return {
        content: [{ type: "text", text: `deleted label ${label_id}` }],
      };
    },
  );
}

