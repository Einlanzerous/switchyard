// External refs CRUD (GitHub PR / issue / commit / Actions / generic links
// attached to tickets). Wraps the same REST endpoints the web UI uses; the
// poller backfills `state` / `title` / `polled_at` on its next cycle, so
// callers only need to supply `url` (and optionally `kind` — the server
// infers it from URL shape otherwise).

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getClient } from "../client.js";
import { formatApiError } from "../errors.js";

const EXTERNAL_REF_KIND = z.enum([
  "github_pr",
  "github_issue",
  "github_commit",
  "github_action",
  "generic",
]);

export function registerExternalRefTools(server: McpServer): void {
  server.registerTool(
    "list_external_refs",
    {
      title: "List external refs",
      description:
        "Return every external ref attached to this ticket — GitHub PRs / " +
        "issues / commits / Actions runs, plus `generic` URLs. Each row has " +
        "`id` (UUID, needed for `detach_external_ref` by ref_id), `kind`, " +
        "`url`, plus poller-maintained `state` (`open` / `closed` / `merged` " +
        "/ `success` / `failed` — null until first poll), `title`, " +
        "`polled_at`, and `polled_state_changed_at`. `get_ticket` already " +
        "embeds these — prefer this tool only when you don't need the rest " +
        "of the ticket payload.",
      inputSchema: {
        id_or_key: z
          .string()
          .describe("Ticket key (e.g. `SWY-47`) or UUID."),
      },
    },
    async ({ id_or_key }) => {
      const client = getClient();
      const { data, error } = await client.GET(
        "/v1/tickets/{idOrKey}/external-refs",
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
    "attach_external_ref",
    {
      title: "Attach external ref",
      description:
        "Attach a URL (GitHub PR / issue / commit / Actions run, or a " +
        "`generic` link) to a ticket. `kind` is optional — the server infers " +
        "it from URL shape; pass `kind: \"generic\"` to skip URL-shape " +
        "validation. The unique constraint is `(ticket_id, url)`; re-attaching " +
        "the same URL returns a 409 conflict with a clear message (this is " +
        "useful for idempotent agent retries — treat the conflict as success). " +
        "After attach, the existing poller backfills `state` / `title` on its " +
        "next cycle; no extra call needed.",
      inputSchema: {
        id_or_key: z
          .string()
          .describe("Ticket key (e.g. `SWY-47`) or UUID."),
        url: z
          .string()
          .url()
          .describe("URL to attach. Must be a valid absolute URL."),
        kind: EXTERNAL_REF_KIND.optional().describe(
          "Optional `kind` override. Omit to let the server infer from the " +
            "URL (recommended). Use `generic` to attach an arbitrary URL " +
            "that doesn't match GitHub patterns.",
        ),
      },
    },
    async ({ id_or_key, url, kind }) => {
      const client = getClient();
      const { data, error } = await client.POST(
        "/v1/tickets/{idOrKey}/external-refs",
        {
          params: { path: { idOrKey: id_or_key } },
          body: kind ? { url, kind } : { url },
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
    "detach_external_ref",
    {
      title: "Detach external ref",
      description:
        "Detach an external ref. Supply EITHER `ref_id` (the UUID from " +
        "`list_external_refs` / `get_ticket`'s embedded `external_refs`) OR " +
        "the `(id_or_key, url)` pair — when the pair is supplied the tool " +
        "looks up the ref UUID for you (one extra GET round trip), so agents " +
        "with the URL in hand don't have to fetch first. Supplying both " +
        "forms, or neither, is rejected. Returns 204 on success; detaching a " +
        "URL that isn't attached returns a clear `not_found` error.",
      inputSchema: {
        ref_id: z
          .string()
          .optional()
          .describe(
            "External-ref UUID (the `id` field from `list_external_refs`).",
          ),
        id_or_key: z
          .string()
          .optional()
          .describe(
            "Ticket key (e.g. `SWY-47`) or UUID. Required when looking up by " +
              "URL; ignored when `ref_id` is supplied.",
          ),
        url: z
          .string()
          .url()
          .optional()
          .describe(
            "URL to detach. Required when looking up by URL; ignored when " +
              "`ref_id` is supplied.",
          ),
      },
    },
    async ({ ref_id, id_or_key, url }) => {
      const byId = Boolean(ref_id);
      const byUrl = Boolean(id_or_key && url);
      if (byId === byUrl) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text:
                "supply exactly one of: `ref_id`, or both `id_or_key` and `url`",
            },
          ],
        };
      }

      const client = getClient();

      let id = ref_id;
      if (!id) {
        const list = await client.GET(
          "/v1/tickets/{idOrKey}/external-refs",
          { params: { path: { idOrKey: id_or_key! } } },
        );
        if (list.error) {
          return {
            isError: true,
            content: [{ type: "text", text: formatApiError(list.error) }],
          };
        }
        const match = list.data?.items.find((r) => r.url === url);
        if (!match) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text:
                  `switchyard error [not_found]: no external ref with url ${url} on ${id_or_key}`,
              },
            ],
          };
        }
        id = match.id;
      }

      const { error } = await client.DELETE(
        "/v1/tickets/external-refs/{id}",
        { params: { path: { id: id! } } },
      );
      if (error) {
        return {
          isError: true,
          content: [{ type: "text", text: formatApiError(error) }],
        };
      }
      return {
        content: [{ type: "text", text: `detached external ref ${id}` }],
      };
    },
  );
}
