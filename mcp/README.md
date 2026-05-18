# @switchyard/mcp

Model Context Protocol server for switchyard. Lets MCP-aware agents — Claude
Desktop, Claude Code, Cline, Gemini CLI, anything that speaks MCP — read and
write switchyard tickets through a hand-curated tool surface.

See PHASES.md "Phase 5.0" for the design rationale. Short version: tools are
hand-shaped for agent consumption (composed workflows, encoded invariants like
"PATCH never changes status — use transition"), but request/response shapes
come from the same generated `api.types.ts` as the web client, so HTTP
plumbing stays in lockstep with the REST API automatically.

## Status

Phase 5.0 in flight. Working today: scaffold, stdio transport, `list_projects`.
Full tool surface (`list_tickets`, `create_ticket`, `transition_ticket`,
`comment_on_ticket`, etc.) lands in follow-up commits on the same branch.

## Configuration

Two env vars:

| Name | Required | Default | Notes |
|---|---|---|---|
| `SWITCHYARD_TOKEN` | yes | — | Bearer token for the actor the MCP server runs as. Mint per agent (`claude`, `n8n-cogitation`, `cline-magos`, etc.) so the audit log attributes correctly. |
| `SWITCHYARD_URL` | no | `http://localhost:4002` | Base URL of the switchyard API. Set to your tailnet URL when running outside the construct host. |

## Local dev

```sh
# from repo root
bun install                                  # one-time
SWITCHYARD_TOKEN=sw_... \
  SWITCHYARD_URL=http://localhost:4012 \
  bun run dev:mcp                            # restarts on file changes
```

The dev backend on :4012 (against `switchyard_test`) is the right target for
iteration. Don't point `SWITCHYARD_URL` at the prod backend (`:4002`) until
you trust the tool surface.

## Wiring into Claude Desktop / Claude Code

Add to `~/.config/Claude/claude_desktop_config.json` (or the equivalent
Claude Code MCP config):

```json
{
  "mcpServers": {
    "switchyard": {
      "command": "bun",
      "args": ["/absolute/path/to/switchyard/mcp/src/index.ts"],
      "env": {
        "SWITCHYARD_TOKEN": "sw_...",
        "SWITCHYARD_URL": "http://imperial-construct:4002"
      }
    }
  }
}
```

## Wiring into Cline

Cline's MCP config lives under the gear icon → MCP Servers. Same shape as
above. The switchyard MCP server will appear in the agent's tool list once
saved; no restart required (Cline hot-reloads MCP configs).

## Smoke test (manual)

```sh
# Confirm tools/list works without any client
(printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'; \
 sleep 0.5) | SWITCHYARD_TOKEN=... SWITCHYARD_URL=... bun src/index.ts
```

You should see a JSON-RPC `initialize` response followed by the tools list.
