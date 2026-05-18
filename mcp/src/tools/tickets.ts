// Ticket MCP tools — the bulk of the v1 surface. Tool descriptions
// encode invariants the OpenAPI schema can't express (PATCH-vs-transition,
// resolution-required-on-close, atomic comment-with-transition). When in
// doubt, lean verbose: agents read these once per session, not once per call.

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getClient } from "../client.js";
import { formatApiError } from "../errors.js";

const TICKET_TYPE = z.enum(["spike", "task", "bug", "epic"]);
const PRIORITY = z.enum(["low", "medium", "high", "critical"]);
const RESOLUTION = z.enum(["done", "released", "cancelled"]);

export function registerTicketTools(server: McpServer): void {
  server.registerTool(
    "list_tickets",
    {
      title: "List tickets",
      description:
        "Search and filter tickets across all projects (or scoped to one). All filter " +
        "parameters are optional and combine with AND. For an actor's own open work, " +
        "prefer `query_my_open` instead — it's pre-shaped for that use case. " +
        "Use `sort_by=due_date` + `sort_order=asc` to triage upcoming deadlines; " +
        "`sort_by=updated_at` + `desc` for recent activity (default). " +
        "The `due` shortcut filters relative to today: `overdue`, `this_week`, or `none` " +
        "(no due_date set). Results paginate via `cursor`.",
      inputSchema: {
        project: z
          .string()
          .optional()
          .describe("Project key to scope results, e.g. `SWY`."),
        status: z
          .string()
          .optional()
          .describe(
            "Status filter. Accepts a category (e.g. `in_progress`) or a status UUID. " +
              "Single value only — the underlying API does not support negation or arrays.",
          ),
        type: TICKET_TYPE.optional().describe("Filter by ticket type."),
        label: z.string().optional().describe("Label name filter."),
        assignee: z
          .string()
          .optional()
          .describe("Assignee user UUID. Use `query_my_open` for assignee=self."),
        reporter: z.string().optional().describe("Reporter user UUID."),
        parent_id: z
          .string()
          .optional()
          .describe("Parent ticket UUID; surfaces only that epic's children."),
        text: z
          .string()
          .optional()
          .describe("Full-text search against title + description."),
        updated_after: z
          .string()
          .optional()
          .describe("ISO-8601 timestamp; return tickets updated strictly after this."),
        updated_before: z
          .string()
          .optional()
          .describe("ISO-8601 timestamp; return tickets updated strictly before this."),
        due: z
          .enum(["overdue", "this_week", "none"])
          .optional()
          .describe(
            "Due-date shortcut: `overdue` (past due, not closed), `this_week` (due " +
              "within the next 7 days), `none` (no due date set).",
          ),
        sort_by: z
          .enum(["updated_at", "due_date", "created_at", "priority"])
          .optional()
          .describe("Sort key. Defaults to `updated_at`."),
        sort_order: z
          .enum(["asc", "desc"])
          .optional()
          .describe("Sort direction. Defaults to `desc`."),
        cursor: z
          .string()
          .optional()
          .describe("Opaque pagination cursor from a previous response."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe("Page size, 1–200. Default server-side is 50."),
      },
    },
    async (input) => {
      const client = getClient();
      const { data, error } = await client.GET("/v1/tickets", {
        params: { query: input },
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
    "get_ticket",
    {
      title: "Get ticket",
      description:
        "Fetch a single ticket by key (e.g. `SWY-47`) or UUID. Returns the full " +
        "ticket payload including description, status, assignee, labels, external_refs, " +
        "metadata, and comment count. For just the comments, follow up with a separate " +
        "call (not yet exposed as an MCP tool — request via the REST API if needed).",
      inputSchema: {
        id_or_key: z
          .string()
          .describe("Ticket key (e.g. `SWY-47`) or UUID. Keys are case-sensitive."),
      },
    },
    async ({ id_or_key }) => {
      const client = getClient();
      const { data, error } = await client.GET("/v1/tickets/{idOrKey}", {
        params: { path: { idOrKey: id_or_key } },
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
    "create_ticket",
    {
      title: "Create ticket",
      description:
        "Create a new ticket. Required: `project_key`, `type`, `title`. " +
        "If `status_id` is omitted, the project's default status applies (this is " +
        "the right choice 99% of the time — agents that try to land tickets directly " +
        "into `in_progress` usually shouldn't). To target a specific status, look it " +
        "up first via `get_project_statuses`. `parent_id` must point at an `epic`-type " +
        "ticket (epics-cannot-nest is a hard invariant). `metadata` is a free-form " +
        "JSON object for custom fields (e.g. `{repo_url, mode, test_cmd}` for the " +
        "imperium-loop pipeline).",
      inputSchema: {
        project_key: z
          .string()
          .describe("Project key (e.g. `SWY`). Case-sensitive."),
        type: TICKET_TYPE.describe("Ticket type."),
        title: z.string().describe("Short ticket title."),
        description: z
          .string()
          .optional()
          .describe("Markdown body. Server stores raw markdown; clients render."),
        status_id: z
          .string()
          .optional()
          .describe(
            "Status UUID to land in. Omit to use the project default; only set when " +
              "you have a specific reason (look up via `get_project_statuses`).",
          ),
        priority: PRIORITY.optional().describe("Priority."),
        parent_id: z
          .string()
          .optional()
          .describe("Parent epic UUID. Only epics can have children (one level deep)."),
        assignee_id: z.string().optional().describe("Assignee user UUID."),
        due_date: z.string().optional().describe("ISO-8601 due date."),
        label_ids: z.array(z.string()).optional().describe("Label UUIDs to attach."),
        metadata: z
          .record(z.unknown())
          .optional()
          .describe(
            "Free-form custom-field map (e.g. `{repo_url: '...', mode: 'modify'}`).",
          ),
      },
    },
    async (input) => {
      const client = getClient();
      const { data, error } = await client.POST("/v1/tickets", {
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
    "update_ticket",
    {
      title: "Update ticket",
      description:
        "Partial update of a ticket's mutable fields. PATCH semantics: only fields " +
        "supplied are changed. **PATCH NEVER CHANGES STATUS.** To change a ticket's " +
        "status, use `transition_ticket` instead — that path enforces the project's " +
        "transitions table, the resolution-required-on-close rule, and the epic-close " +
        "guard. Trying to PATCH `status_id` here is a no-op at best, an error at worst.",
      inputSchema: {
        id_or_key: z.string().describe("Ticket key (e.g. `SWY-47`) or UUID."),
        title: z.string().optional().describe("New title."),
        description: z.string().optional().describe("New markdown description."),
        priority: PRIORITY.optional().describe("New priority."),
        assignee_id: z
          .string()
          .optional()
          .describe("New assignee user UUID. Pass empty string to clear (if API supports)."),
        due_date: z.string().optional().describe("New ISO-8601 due date."),
        label_ids: z
          .array(z.string())
          .optional()
          .describe("Full label set (replaces existing labels)."),
        metadata: z
          .record(z.unknown())
          .optional()
          .describe("Custom-field map. Merge semantics depend on server."),
      },
    },
    async ({ id_or_key, ...body }) => {
      const client = getClient();
      const { data, error } = await client.PATCH("/v1/tickets/{idOrKey}", {
        params: { path: { idOrKey: id_or_key } },
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
    "transition_ticket",
    {
      title: "Transition ticket status",
      description:
        "Move a ticket to a new status. Validates against the project's transitions " +
        "table (if configured) and the epic-close guard (an epic with open children " +
        "cannot close). " +
        "**`status_id` is project-scoped** — call `get_project_statuses` on the " +
        "ticket's project first to find the right UUID. " +
        "**`resolution` is REQUIRED when transitioning into any `closed`-category " +
        "status** (one of `done`, `released`, `cancelled`). Omitting it returns a " +
        "422 validation error. " +
        "Use the optional `comment` to attach context atomically with the move — " +
        "this is preferred over a separate `comment_on_ticket` call when the comment " +
        "explains the transition (e.g. 'closing as done — merged in PR #123').",
      inputSchema: {
        id_or_key: z.string().describe("Ticket key (e.g. `SWY-47`) or UUID."),
        status_id: z
          .string()
          .describe(
            "Target status UUID (project-scoped; look up via `get_project_statuses`).",
          ),
        resolution: RESOLUTION.optional().describe(
          "REQUIRED when target status category is `closed`. `done` = work complete, " +
            "`released` = shipped to users, `cancelled` = abandoned without completion.",
        ),
        comment: z
          .string()
          .optional()
          .describe(
            "Optional comment body attached atomically with the transition. " +
              "Prefer this over a separate comment call when the comment explains the move.",
          ),
        position: z
          .number()
          .optional()
          .describe("Optional position within the destination column."),
      },
    },
    async ({ id_or_key, ...body }) => {
      const client = getClient();
      const { data, error } = await client.POST(
        "/v1/tickets/{idOrKey}/transition",
        {
          params: { path: { idOrKey: id_or_key } },
          body,
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
    "comment_on_ticket",
    {
      title: "Comment on ticket",
      description:
        "Add a comment to a ticket. Comments are markdown. Use this for standalone " +
        "notes; if you're commenting *because* you're transitioning the ticket, prefer " +
        "the `comment` field on `transition_ticket` so the audit log shows one atomic " +
        "event instead of two.",
      inputSchema: {
        id_or_key: z.string().describe("Ticket key (e.g. `SWY-47`) or UUID."),
        body: z.string().describe("Comment body (markdown)."),
      },
    },
    async ({ id_or_key, body }) => {
      const client = getClient();
      const { data, error } = await client.POST(
        "/v1/tickets/{idOrKey}/comments",
        {
          params: { path: { idOrKey: id_or_key } },
          body: { body },
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
    "move_ticket",
    {
      title: "Move ticket to another project",
      description:
        "Move a ticket to a different project. The ticket is allocated a new key in " +
        "the destination project; the old key remains resolvable (alias). Use this for " +
        "the IL-5 graduation flow (INCUBATOR → new project) or any cross-project " +
        "reorganization. Optional `status_id` lets you simultaneously land the ticket " +
        "in a specific destination status (must be a status in the *destination* " +
        "project — look up via `get_project_statuses` on the new project key). Optional " +
        "`parent_id` rewires the epic parent; pass `null` to detach.",
      inputSchema: {
        id_or_key: z.string().describe("Ticket key (e.g. `SWY-47`) or UUID."),
        project_key: z.string().describe("Destination project key."),
        status_id: z
          .string()
          .optional()
          .describe(
            "Optional destination status UUID (look up via `get_project_statuses` " +
              "on the destination project).",
          ),
        parent_id: z
          .string()
          .nullable()
          .optional()
          .describe("New parent epic UUID, or `null` to detach."),
      },
    },
    async ({ id_or_key, ...body }) => {
      const client = getClient();
      const { data, error } = await client.POST("/v1/tickets/{idOrKey}/move", {
        params: { path: { idOrKey: id_or_key } },
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
}
