# Using the switchyard API from agents

The HTTP API is the surface every agent (n8n flows, Claude / Gemini / Cline,
custom scripts) talks to. Same surface the web UI uses — there is no separate
"agent" endpoint set. This page gathers the conventions agents need to know.

For a curated, agent-shaped tool surface on top of the same API, see the
[MCP server](../mcp/README.md).

## Authentication

Every `/v1/*` request needs a bearer token. Tokens belong to a user
(`POST /v1/users/{id}/tokens`); the plaintext is returned **once** at
creation. Store it in n8n credentials, the agent's env, etc. — never log it.

```bash
curl -H "Authorization: Bearer sw_..." http://switchyard:4002/v1/users/me
```

Per-agent tokens are the norm — mint one per actor (`claude`, `n8n-cogitation`,
`servo-signal`, `cline-magos`, etc.) so the audit log attributes mutations
correctly.

A freshly-minted token can also be encoded as a QR code on the
`/settings/tokens` "show secret once" banner. The QR wraps the token in a
`${origin}/login?token=…` URL so any phone's native scanner opens the
browser directly at `/login` with the bearer pre-filled. The `/login` view
also has an in-app "Scan QR" affordance for browsers that ship the
`BarcodeDetector` API. Either path beats copy-pasting the bearer between
devices.

## Idempotency

Every POST/PATCH/DELETE accepts an `Idempotency-Key` header. Replays within
24h return the original cached response (status + body) — agents can retry
safely without creating duplicates.

```bash
KEY=$(uuidgen)
curl -X POST -H "Authorization: Bearer $TOK" -H "Idempotency-Key: $KEY" \
  -H 'Content-Type: application/json' \
  http://switchyard:4002/v1/tickets \
  -d '{"project_key":"FLOW","type":"task","title":"automated ticket"}'
# Repeating the call with the same KEY returns the same ticket — not a 409.
```

Keys are scoped per `(user, method, path)`. Reusing a key across endpoints or
across actors is a programming error.

## Cursor pagination

List endpoints return:

```json
{
  "items": [ /* ... */ ],
  "page": { "next_cursor": "eyJ1Ijoi...", "has_more": true }
}
```

Pass `next_cursor` back in `?cursor=...` to fetch the next page. Treat the
cursor as opaque — the format is `(sort_key, id)` pairs encoded base64url, but
it can change.

## Error envelope

Non-2xx responses always look like:

```json
{ "error": { "code": "unprocessable", "message": "...", "details": { /* optional */ } } }
```

Codes: `bad_request | unauthorized | forbidden | not_found | conflict |
unprocessable | rate_limited | internal | service_unavailable`. Parse `code`,
surface `message`. `details` is endpoint-specific (e.g. `open_children` on
the epic-close guard).

## Webhook signature verification

Outbound webhooks include `X-Switchyard-Signature: sha256=<hex>` — the
HMAC-SHA256 of the request body using the subscription's secret. Verify
before trusting the payload.

**Node.js:**

```js
import { createHmac, timingSafeEqual } from "node:crypto";

function verify(secret, rawBody, headerValue) {
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const sig = (headerValue ?? "").replace(/^sha256=/, "");
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(sig, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}
```

**Python:**

```python
import hmac, hashlib

def verify(secret: str, raw_body: bytes, header_value: str) -> bool:
    expected = hmac.new(secret.encode(), raw_body, hashlib.sha256).hexdigest()
    sig = header_value.removeprefix("sha256=")
    return hmac.compare_digest(expected, sig)
```

n8n's Webhook node can do this in a Code step or via header-auth if you embed
the secret in a constant header instead.

### Outbound payload shape

All outbound webhooks share one envelope:

```json
{
  "id": "evt_<uuid>",
  "event": "ticket.status_changed",
  "occurred_at": "2026-05-02T15:04:05Z",
  "actor": { "id": "<uuid>", "name": "magos", "type": "human" },
  "ticket": { /* full embedded ticket */ },
  "changes": { "status": { "from": { /* ... */ }, "to": { /* ... */ } } }
}
```

Event type is also surfaced in `X-Switchyard-Event` for routing without body
parsing.

## Status transitions vs PATCH

`PATCH /v1/tickets/{id}` does **not** change `status_id` — that's
intentional. All status changes go through `POST /v1/tickets/{id}/transition`,
which enforces:

- the project's transitions whitelist (when defined),
- `resolution` is required iff target category is `closed`,
- the epic-close guard refuses to close an epic with open child tickets
  (response includes `details.open_children`).

## Filters on `GET /v1/tickets`

Comma-separated values are supported on `project`, `status`, `type`, `label`.
Status accepts both UUIDs and category names mixed.

```
GET /v1/tickets?project=FLOW,DEMO&status=in_progress,blocked&type=bug,task&label=<uuid>&assignee=<uuid>&text=login&updated_after=2026-05-01T00:00:00Z
```

`assignee=unassigned` filters tickets with no assignee. `sort_by` accepts
`updated_at` (default), `due_date`, `created_at`, `priority`; `sort_order` is
`asc` or `desc`.

## Request IDs

Every response carries an `X-Request-ID` header. Agents that log API calls
should include this in their logs so server-side logs can be cross-referenced.

## GitHub webhook receiver

`POST /v1/external/github` accepts GitHub's webhook deliveries. When a PR
title or branch name mentions a switchyard ticket key (`SWY-42`, `[SWY-7]`,
`magos/SWY-12-foo`), the receiver auto-creates a `ticket_external_refs` row
pointing at the PR — same shape as a manual attach. Subsequent
`closed` / `merged` events transition the ref's `state`, emitting
`ticket.external_ref_state_changed` so rules and subscriptions can react.

**Setup:**

1. Set `GITHUB_WEBHOOK_SECRET` in the backend's environment (any opaque
   string ≥ 8 chars). Without it the route responds 503 — the receiver is
   opt-in.
2. Optionally set `EXTERNAL_REF_KEY_PREFIX` (default `SWY`) to limit which
   project keys match. `*` matches any project key shape (`FOO-42`,
   `BAR-13`, etc.).
3. In the GitHub repo settings → Webhooks, add:
   - **Payload URL:** `https://<switchyard-host>/v1/external/github`
   - **Content type:** `application/json`
   - **Secret:** same value as `GITHUB_WEBHOOK_SECRET`
   - **Events:** "Let me select individual events" → check **Pull requests**.
     Other events return 200 silently.

The receiver is auth-by-HMAC only (no bearer token); the signature in
`X-Hub-Signature-256` is verified against the configured secret. A bad
signature returns 401 and GitHub stops retrying.

Polling stays active as the reconciliation backstop, so a missed webhook
delivery doesn't strand a ref at a stale state.
