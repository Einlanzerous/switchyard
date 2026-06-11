# @switchyard/mcp

Model Context Protocol server for switchyard. Lets MCP-aware agents — Claude
Desktop, Claude Code, Cline, Gemini CLI, anything that speaks MCP — read and
write switchyard tickets through a hand-curated tool surface.

The server lives at [`mcp/`](../mcp/) in the repo. See PHASES.md "Phase 5.0" for
the design rationale. Short version: tools are hand-shaped for agent consumption
(composed workflows, encoded invariants like "PATCH never changes status — use
transition"), but request/response shapes come from the same generated
`api.types.ts` as the web client, so HTTP plumbing stays in lockstep with the
REST API automatically.

## Status

Stdio transport, in-memory test harness, fifteen tools registered:

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

## What your token can see

The MCP server holds **no authorization logic of its own** — it is a thin
pass-through that stamps `Authorization: Bearer $SWITCHYARD_TOKEN` on every REST
call. The backend resolves access through the Phase 6 permissions model, so:

> **Your MCP access equals your token's access — nothing more, nothing less.**
> The token is the entire blast radius; the MCP layer can't widen or narrow it.

What that means in practice:

- **Agent / owner tokens are instance-wide.** A token on an agent user
  (`claude`, `n8n-cogitation`, …) or on the instance owner reads and writes
  *every* project — the `hasInstanceWideAccess` bypass. This is the imperium-loop
  default.
- **Human member tokens are project-scoped.** A `member` human (e.g. a friend
  invited as a viewer on one project) sees and writes only the projects they
  hold a membership row on, at their role (`viewer` read-only, `editor` writes,
  `admin` project config), intersected with the token's scopes.
- **Dashboard-kind tokens are read-only by construction**, regardless of role.

So minting a token *is* granting access. To onboard a human to MCP, add them to
the right project(s) at the right role first (Settings → Members), then mint
their token on their user. See [permissions.md](./permissions.md) for the full
model and [agents.md](./agents.md) for the agent-vs-human service-account
distinction.

## Configuration

Two env vars:

| Name | Required | Default | Notes |
|---|---|---|---|
| `SWITCHYARD_TOKEN` | yes | — | Bearer token for the actor the MCP server runs as. Mint per actor (`claude`, `n8n-cogitation`, `cline-magos`, `areese`, …) so the audit log attributes correctly. |
| `SWITCHYARD_URL` | no | `http://localhost:4002` | Base URL of the switchyard API. Set to the tailnet host when running outside the construct box (see Path B below). |

## Setup

The package is private and runs from source — there is no published npm
artifact. Both paths below assume you have **[Bun](https://bun.sh)** installed
and the repo cloned locally.

```sh
git clone https://github.com/Einlanzerous/switchyard.git
cd switchyard && bun install   # installs the mcp/ workspace too
```

Pick the path that matches your situation, get a token, then wire it into your
MCP client.

### Path A — Fresh install (your own instance)

For standing up a brand-new switchyard you control.

1. Deploy the backend (docker compose) and run the migration/seed step
   (`bun run db:migrate`) — it prints a one-time **bootstrap token** on first
   run.
2. Mint yourself a user + token using the bootstrap token:
   ```sh
   curl -X POST -H "Authorization: Bearer $BOOTSTRAP_TOKEN" \
     -H 'Content-Type: application/json' \
     http://localhost:4002/v1/users/$USER_ID/tokens \
     -d '{"name":"claude-desktop"}'
   ```
3. Your `SWITCHYARD_URL` is `http://localhost:4002` (or wherever you exposed the
   backend).

### Path B — Connect to imperial-construct over Tailscale

For connecting to the **existing** instance running on the construct box — this
is the path for both magos's desktop and any invited human (e.g. Arin).

1. **Be on the tailnet.** You need to reach the construct host. Either of these
   `SWITCHYARD_URL` values works:
   - `http://imperial-construct:4002` (MagicDNS name), or
   - `http://100.112.250.4:4002` (MagicDNS IP — use if name resolution flakes).
2. **Get a token.**
   - *magos:* you already hold an owner (instance-wide) token — reuse it or mint
     a dedicated one for the desktop.
   - *A new human (Arin):* you can't self-serve. The instance owner adds your
     user (`areese`) to the relevant project(s) at a role in **Settings →
     Members**, then mints your token on your user and shares it via the
     "show secret once" QR banner (`/settings/tokens`) or another secure
     channel. Your MCP will then see exactly those projects at that role — see
     [What your token can see](#what-your-token-can-see).

### Wire into your MCP client

**Claude Desktop / Claude Code** — add to
`~/.config/Claude/claude_desktop_config.json` (or the equivalent Claude Code MCP
config):

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

Use the `SWITCHYARD_URL` for your path: `http://localhost:4002` (Path A) or
`http://imperial-construct:4002` / `http://100.112.250.4:4002` (Path B). Restart
the client and the switchyard tools appear in its tool list.

**Cline** — same shape, configured under the gear icon → MCP Servers. The
server appears once saved; no restart required (Cline hot-reloads MCP configs).

### Windows + WSL2

If Claude Desktop runs on **Windows** but `bun` and the repo live in **WSL2**,
wrap the launch in `wsl.exe` so the server runs inside the distro. The config
lives on the Windows side (`%APPDATA%\Claude\claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "switchyard": {
      "command": "wsl.exe",
      "args": [
        "-d", "Ubuntu", "-u", "magos", "-e", "bash", "-lc",
        "SWITCHYARD_TOKEN=sw_... SWITCHYARD_URL=http://100.112.250.4:4002 exec bun /home/magos/projects/switchyard/mcp/src/index.ts"
      ]
    }
  }
}
```

- stdio passes through `wsl.exe` cleanly — that's all the MCP transport needs.
- `-lc` runs a **login shell** so `bun` is on `PATH`; if it still isn't, use the
  absolute path (e.g. `/home/<user>/.bun/bin/bun`). `-d` is the distro
  (`wsl -l` lists them), `-u` the user, and `exec` replaces the shell so
  shutdown signals propagate.
- Use the **WSL path** (`/home/...`), not a Windows path, and inline the env in
  the command — Windows env vars don't cross into WSL without `WSLENV`.
- The path must point at a clone **on that machine**. A `Module not found`
  error means the repo isn't where the arg says — your desktop WSL is a
  different box from the server, so clone it there (and check the username; it
  may not be the server's) or use the SSH variant below.

**No clone on the desktop?** Run the server on the host that already has it over
SSH — stdio flows over the SSH pipe, and because the server runs *on* the host,
`SWITCHYARD_URL` becomes `http://localhost:4002` and the WSL networking question
disappears entirely:

```json
{
  "mcpServers": {
    "switchyard": {
      "command": "wsl.exe",
      "args": ["-d", "Ubuntu", "-u", "<wsl-user>", "-e", "bash", "-lc",
        "exec ssh imperial-construct 'SWITCHYARD_TOKEN=sw_... SWITCHYARD_URL=http://localhost:4002 bun /home/magos/projects/switchyard/mcp/src/index.ts'"]
    }
  }
}
```

Requires key-based SSH from WSL to the host (`wsl ssh imperial-construct` should
connect with no password prompt first).

**Networking is the real gotcha**, not the launcher: the bun process runs
*inside* WSL2, so WSL2 must reach the tailnet. Verify from inside WSL:

```sh
curl -s http://100.112.250.4:4002/healthz   # JSON → you're good
```

If it hangs, default WSL2 NAT can't reach the Windows Tailscale. Enable
**mirrored networking** (Windows 11) — add to `C:\Users\<you>\.wslconfig`:

```ini
[wsl2]
networkingMode=mirrored
```

then `wsl --shutdown` and retry; mirrored mode shares the host's `tailscale0`,
so both `100.112.250.4` and the `imperial-construct` MagicDNS name resolve from
WSL. (Alternatively, install `bun` natively on Windows and drop the `wsl.exe`
wrapper — the call then originates from Windows, where Tailscale already works.)

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
