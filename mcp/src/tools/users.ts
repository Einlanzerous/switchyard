// User + API-token management MCP tools. Wraps the REST surface in
// server/src/routes/users.ts so an operator can onboard a teammate (create a
// user, mint/revoke a token) end-to-end through MCP instead of falling back to
// raw `curl` with an admin token.
//
// BLAST RADIUS — read before wiring a token to these tools:
// Every tool here requires the admin-tier `users:manage` scope AND
// instance-admin (`type=agent` OR `instance_role=owner`, see
// server/src/lib/authz.ts `hasInstanceWideAccess`). That means the token these
// tools run under can create/delete ANY user and mint admin tokens for them —
// a large surface. Prefer minting a SEPARATE, narrowly-scoped admin token used
// only for user administration over granting `users:manage` to the long-lived
// default `claude` MCP token. (You can mint that very token with
// `create_user_token` once an owner has bootstrapped one.)

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getClient } from "../client.js";
import { formatApiError } from "../errors.js";

const USER_TYPE = z.enum(["agent", "human"]);
const INSTANCE_ROLE = z.enum(["owner", "member"]);
const TOKEN_KIND = z.enum(["personal", "agent", "dashboard"]);
const TOKEN_SCOPE = z.enum([
  "tickets:read",
  "tickets:write",
  "comments:write",
  "attachments:write",
  "webhooks:manage",
  "projects:manage",
  "users:manage",
  "rules:manage",
  "targets:manage",
  "llm-obs:write",
  "admin",
]);

// Shared note appended to every tool description so the admin-tier requirement
// is impossible to miss when an agent is deciding whether to reach for these.
const ADMIN_NOTE =
  " Requires the admin-tier `users:manage` scope + instance-admin; prefer a " +
  "separate narrowly-scoped admin token over granting this to the default MCP token.";

export function registerUserTools(server: McpServer): void {
  server.registerTool(
    "list_users",
    {
      title: "List users",
      description:
        "List the instance user directory (humans + agents). Each user has an " +
        "`id` (UUID), `name`, `type` (`agent`/`human`), `instance_role` " +
        "(`owner`/`member`), and an optional `email` (used for Cloudflare " +
        "Access SSO). Use this to find the `id` you need for " +
        "`update_user`, `delete_user`, or the token tools. Results paginate via " +
        "`cursor`." + ADMIN_NOTE,
      inputSchema: {
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
          .describe("Page size (1–200). Server default applies when omitted."),
      },
    },
    async ({ cursor, limit }) => {
      const client = getClient();
      const { data, error } = await client.GET("/v1/users", {
        params: {
          query: {
            ...(cursor !== undefined ? { cursor } : {}),
            ...(limit !== undefined ? { limit } : {}),
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
          { type: "text", text: JSON.stringify(data?.items ?? [], null, 2) },
        ],
      };
    },
  );

  server.registerTool(
    "create_user",
    {
      title: "Create user",
      description:
        "Create a new user (human teammate or agent). `type=human` is the usual " +
        "choice when onboarding a person; `type=agent` is for automation " +
        "identities (agents bypass project scoping — see the blast-radius note). " +
        "`instance_role` defaults to `member` server-side; pass `owner` only for " +
        "a full instance admin. Creating the user does NOT mint a token — follow " +
        "up with `create_user_token` to issue credentials." + ADMIN_NOTE,
      inputSchema: {
        name: z
          .string()
          .min(1)
          .max(100)
          .describe("Display name (1–100 chars), e.g. `kglawrence`."),
        type: USER_TYPE.describe(
          "`human` for a person, `agent` for an automation identity.",
        ),
        instance_role: INSTANCE_ROLE.optional().describe(
          "`owner` (full instance admin) or `member` (project-scoped). Defaults to `member`.",
        ),
        icon: z
          .string()
          .max(500)
          .optional()
          .describe("Optional icon/avatar URL or emoji (max 500 chars)."),
        email: z
          .string()
          .email()
          .optional()
          .describe(
            "Email for Cloudflare Access SSO matching. Must be unique among " +
              "active users; lowercased server-side.",
          ),
      },
    },
    async (input) => {
      const client = getClient();
      const { data, error } = await client.POST("/v1/users", { body: input });
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
    "update_user",
    {
      title: "Update user",
      description:
        "Update a user's mutable fields. Only supplied fields are touched; omit a " +
        "field to leave it unchanged. Use this to rename, swap `type`, or " +
        "promote/demote `instance_role`. The server refuses (422) to demote the " +
        "LAST remaining owner — promote another user to `owner` first." + ADMIN_NOTE,
      inputSchema: {
        user_id: z.string().describe("User UUID (from `list_users`)."),
        name: z.string().min(1).max(100).optional().describe("New display name."),
        type: USER_TYPE.optional().describe("New type (`agent`/`human`)."),
        instance_role: INSTANCE_ROLE.optional().describe(
          "New instance role (`owner`/`member`). Cannot demote the last owner.",
        ),
        icon: z.string().max(500).optional().describe("New icon/avatar (max 500 chars)."),
        email: z
          .string()
          .email()
          .nullable()
          .optional()
          .describe(
            "New email for Cloudflare Access SSO matching (null clears it). " +
              "Must be unique among active users; lowercased server-side.",
          ),
      },
    },
    async ({ user_id, ...body }) => {
      const client = getClient();
      const { data, error } = await client.PATCH("/v1/users/{id}", {
        params: { path: { id: user_id } },
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
    "delete_user",
    {
      title: "Delete user",
      description:
        "Soft-delete a user (sets `deleted_at`; recoverable server-side, but the " +
        "user can no longer authenticate). DESTRUCTIVE — you must pass " +
        "`confirm: true` to proceed; without it the tool refuses and makes no " +
        "change. Their tokens stop working too. Revoke individual tokens with " +
        "`revoke_user_token` if you only want to cut access without removing the " +
        "user." + ADMIN_NOTE,
      inputSchema: {
        user_id: z.string().describe("User UUID (from `list_users`)."),
        confirm: z
          .boolean()
          .optional()
          .describe("Must be `true` to actually delete. Omitted/false = no-op guard."),
      },
    },
    async ({ user_id, confirm }) => {
      if (confirm !== true) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text:
                `Refusing to delete user ${user_id}: pass \`confirm: true\` to proceed. ` +
                "This soft-deletes the user and disables their tokens.",
            },
          ],
        };
      }
      const client = getClient();
      const { error } = await client.DELETE("/v1/users/{id}", {
        params: { path: { id: user_id } },
      });
      if (error) {
        return {
          isError: true,
          content: [{ type: "text", text: formatApiError(error) }],
        };
      }
      return {
        content: [{ type: "text", text: `soft-deleted user ${user_id}` }],
      };
    },
  );

  server.registerTool(
    "list_user_tokens",
    {
      title: "List a user's API tokens",
      description:
        "List the API tokens issued to a user. Returns token METADATA only — `id`, " +
        "`name`, `kind`, `scopes`, `last_used_at`, `revoked_at` — never the secret " +
        "(plaintext is shown once at creation and not stored in retrievable form). " +
        "Use the token `id` here with `revoke_user_token`." + ADMIN_NOTE,
      inputSchema: {
        user_id: z.string().describe("User UUID (from `list_users`)."),
      },
    },
    async ({ user_id }) => {
      const client = getClient();
      const { data, error } = await client.GET("/v1/users/{id}/tokens", {
        params: { path: { id: user_id } },
      });
      if (error) {
        return {
          isError: true,
          content: [{ type: "text", text: formatApiError(error) }],
        };
      }
      return {
        content: [
          { type: "text", text: JSON.stringify(data?.items ?? [], null, 2) },
        ],
      };
    },
  );

  server.registerTool(
    "create_user_token",
    {
      title: "Mint an API token",
      description:
        "Mint a new API token for a user. The plaintext secret (format " +
        "`sw_...`) is returned EXACTLY ONCE in the `token` field and is never " +
        "retrievable again — surface it to the operator immediately and store it " +
        "securely. `kind=dashboard` is read-only-capped server-side; `personal`/" +
        "`agent` take the `scopes` you pass (server defaults to `admin` when " +
        "omitted, so pass a minimal `scopes` list for least privilege). Revoke " +
        "with `revoke_user_token`." + ADMIN_NOTE,
      inputSchema: {
        user_id: z.string().describe("User UUID the token belongs to (from `list_users`)."),
        name: z
          .string()
          .min(1)
          .max(100)
          .describe("Human label for the token (1–100 chars), e.g. `kglawrence-cli`."),
        kind: TOKEN_KIND.optional().describe(
          "`personal` (default), `agent`, or `dashboard` (read-only-capped).",
        ),
        scopes: z
          .array(TOKEN_SCOPE)
          .optional()
          .describe(
            "Least-privilege scope list. Omit to accept the server default " +
              "(`admin` for personal/agent; read-only for dashboard). Grant " +
              "`users:manage` only for an admin token.",
          ),
      },
    },
    async ({ user_id, ...body }) => {
      const client = getClient();
      const { data, error } = await client.POST("/v1/users/{id}/tokens", {
        params: { path: { id: user_id } },
        body,
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
            text:
              "IMPORTANT: the `token` field below is the plaintext secret. It is " +
              "shown ONCE and cannot be retrieved again — give it to the operator " +
              "now and store it securely. Revoke via `revoke_user_token` if leaked.\n\n" +
              JSON.stringify(data, null, 2),
          },
        ],
      };
    },
  );

  server.registerTool(
    "revoke_user_token",
    {
      title: "Revoke an API token",
      description:
        "Revoke a user's API token (sets `revoked_at`; the secret stops working " +
        "immediately). DESTRUCTIVE — you must pass `confirm: true` to proceed; " +
        "without it the tool refuses and makes no change. Find the `token_id` via " +
        "`list_user_tokens`." + ADMIN_NOTE,
      inputSchema: {
        user_id: z.string().describe("User UUID the token belongs to."),
        token_id: z.string().describe("Token UUID (from `list_user_tokens`)."),
        confirm: z
          .boolean()
          .optional()
          .describe("Must be `true` to actually revoke. Omitted/false = no-op guard."),
      },
    },
    async ({ user_id, token_id, confirm }) => {
      if (confirm !== true) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text:
                `Refusing to revoke token ${token_id}: pass \`confirm: true\` to proceed. ` +
                "This immediately disables the token.",
            },
          ],
        };
      }
      const client = getClient();
      const { error } = await client.DELETE("/v1/users/{id}/tokens/{tokenId}", {
        params: { path: { id: user_id, tokenId: token_id } },
      });
      if (error) {
        return {
          isError: true,
          content: [{ type: "text", text: formatApiError(error) }],
        };
      }
      return {
        content: [{ type: "text", text: `revoked token ${token_id}` }],
      };
    },
  );
}
