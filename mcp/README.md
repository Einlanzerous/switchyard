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

Stdio transport, in-memory test harness, fourteen tools registered:

| Tool | Kind | Purpose |
|---|---|---|
| `list_projects` | read | Project discovery / routing |
| `get_project` | read | Fetch one project by key (idempotency check before `create_project`) |
| `get_project_statuses` | read | Resolve status UUIDs before transitioning |
| `list_labels` | read | Global label catalog (label UUIDs for ticket attach) |
| `list_tickets` | read | Search/filter; `status` accepts array, plus `open: true` shortcut |
| `get_ticket` | read | Fetch one ticket by key or UUID (includes comments inline) |
| `get_ticket_comments` | read | Comments-only view, paginated (lighter than `get_ticket`) |
| `query_my_open` | read | Sugar for "what's on my plate" |
| `create_project` | write | New project; key is immutable; auto-seeded with 5 default statuses |
| `create_ticket` | write | New ticket; omit `status_id` for project default |
| `update_ticket` | write | PATCH; **never** changes status. `null` clears `assignee_id` / `parent_id` / `due_date` |
| `transition_ticket` | write | Status change by explicit `status_id`; resolution required on close |
| `transition_ticket_by_category` | write | Sugar: pick the unique status in a category (skips the lookup) |
| `comment_on_ticket` | write | Standalone comment |
| `move_ticket` | write | Cross-project move (allocates new key, alias preserved) |

Out of scope for this phase (deferred): attachments, webhook/rule
subscriptions, resource-style ticket pages, label / status / transition
CRUD.

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

## Tests

```sh
bun run test:mcp     # from repo root
# or
cd mcp && bun test
```

Uses the MCP SDK's `InMemoryTransport` to wire a client and the real
server through paired transports in-process, then mocks global `fetch`
to assert each tool calls the right endpoint with the right body shape.
No backend required.

## Smoke test (manual)

Drive every tool against a live backend in one shot:

```sh
SWITCHYARD_TOKEN=sw_... SWITCHYARD_URL=http://localhost:4012 \
  bun mcp/scripts/smoke.ts [--project SWY]
```

The script spawns the MCP server via stdio, exercises every tool
(creates a transient `[smoke <timestamp>]` ticket, mutates it,
optionally moves it cross-project if multiple projects exist, then
transitions it to closed with `resolution=done`), and prints a
PASS/FAIL line per tool. Exit code = number of failures.

For just confirming the server boots and registers tools (no backend
needed):

```sh
(printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'; \
 sleep 0.5) | SWITCHYARD_TOKEN=test SWITCHYARD_URL=http://localhost:4012 bun src/index.ts
```
