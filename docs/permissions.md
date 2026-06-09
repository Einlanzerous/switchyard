# Permissions & access control (Phase 6)

Switchyard's authorization is **two-dimensional**: a request's effective
permission on a project is the intersection of the **token's global scopes** and
the **user's role on that project**. Global scopes keep meaning what they did
before Phase 6; the per-project dimension is what makes scoping real — it lets a
human be a read-only `viewer` on one project without seeing the rest of the
instance, while agents keep cross-project access so imperium-loop is untouched.

This document is the enforcement playbook the 6.1.x read-path work follows. The
primitives it describes live in `server/src/lib/authz.ts`.

## The model

- **Instance role** (`users.instance_role`): `owner | member`. `owner` = magos,
  the full instance admin. `member` = every other human.
- **Per-project role** (`user_projects.role`): `admin | editor | viewer`.
  `viewer` = read-only; `editor` = ticket/comment writes; `admin` = project
  config. Membership is the `user_projects` join row itself — no row, no access.
- **Agents are instance-wide service accounts.** `users.type = 'agent'` bypasses
  per-project membership entirely and keeps seeing everything.
- **Effective permission = token scopes ∩ project role.** A `viewer` with an
  `admin` token is still read-only; a read-only (dashboard) token caps an
  `admin`-role user at read.

Owners and agents share one bypass predicate — `hasInstanceWideAccess(user)` —
which is `user.type === 'agent' || user.instance_role === 'owner'`.

## The seven rules

1. **Default-deny, centralized.** Every project-scoped read goes through the
   shared helpers in `lib/authz.ts`. No ad-hoc membership checks inline in
   handlers, and never a bare `type === 'agent'` — that's what
   `hasInstanceWideAccess` is for.

2. **Filter at the query layer, not after.** Use `visibleProjectFilter` to push
   a `WHERE project_id IN (…)` predicate into the handler's existing `conds`
   array. Fetch-then-filter breaks cursor pagination *and* counts — a page of
   `limit` rows that gets filtered down to 3 looks like the end of the list when
   it isn't, and totals are wrong.

3. **Inherited resources resolve up.** A comment's / attachment's / link's
   visibility is its parent ticket's project membership, never its own row in
   isolation. Resolve to the parent ticket's `project_id` first, then check.

4. **Reads 404, writes 403.** For a non-member resource, *reads* return
   `404 not_found` (via `assertProjectReadable`) so a viewer can't probe for the
   existence of projects/tickets they can't see. *Writes* return `403 forbidden`
   (via `assertProjectRole` / `assertInstanceAdmin`) — existence isn't a secret
   once you're already acting on a resource by id.

5. **Owner/agent bypass is one predicate.** `hasInstanceWideAccess`, explicit
   and tested. Never re-derive it.

6. **Every read-endpoint PR extends the negative-access matrix.** When you scope
   an endpoint, add a block to `server/test/integration/negative-access.test.ts`
   asserting the `friend` viewer gets 404 on detail reads of non-member projects
   and never sees their rows in list reads. A new scoped read without a matrix
   row fails review.

7. **CI grep-guard (reads + writes).** `server/scripts/authz-guard.ts` flags
   route files that touch scoped tables without the right gate. The **read**
   check flags `.from(schema.{tickets,projects,boards})` without a read helper
   (`visibleProjectFilter` / `assertProjectReadable` / …); the **write** check
   (added in 6.2) flags `.insert|update|delete(schema.X)` on a project-scoped or
   admin table (`tickets`, `comments`, `statuses`, `projects`, `rules`, `users`,
   …) without a write gate (`assertProjectRole` / `assertInstanceAdmin`). It was
   **advisory through 6.1.0–6.1.4**, **ENFORCING since 6.1.5** — it runs in
   `.github/workflows/ci.yml` and a new unscoped read OR write handler fails the
   build. A file that legitimately touches these tables outside the project model
   (self-scoped notification hydration, owner-scoped saved views, audit-event
   writes) satisfies the guard by referencing the relevant helper, or by living
   on a table the guard doesn't track. Run it any time with
   `bun server/scripts/authz-guard.ts`.

## Helper API (`server/src/lib/authz.ts`)

| Helper | Use |
|---|---|
| `hasInstanceWideAccess(user)` | The single owner/agent bypass predicate. |
| `visibleProjectIds(user)` | Set of project ids the user may see (all live projects for instance-wide actors). |
| `visibleProjectFilter(user, projectIdCol)` | **List reads.** Returns a `WHERE` predicate for `conds[]`: `null` for instance-wide (no filter), `project_id IN (…)` for members, a `FALSE` predicate for a member with zero projects (empty page, pagination intact). |
| `canSeeProject(user, projectId)` | Boolean membership check; cheaper than `visibleProjectIds` for a single resource. |
| `assertProjectReadable(user, projectId, resource)` | **Detail reads.** Throws `404 not_found` for non-members; resolves for members + instance-wide actors. |
| `assertInstanceAdmin(user, surface)` | **Admin surfaces (6.1.5).** Throws `403 forbidden` unless the user is instance-wide (owner/agent). Gates reads on rules/targets/webhooks — whole subsystems, not project-scoped resources, so they 403 (not 404). |
| `visibleUserIds(user)` | **People directory (6.1.5).** Set of user ids a member may see — co-members of their visible projects ∪ all agents ∪ self; `null` (no filter) for instance-wide actors. |
| `assertProjectRole(user, projectId, capability, resource)` | **Writes (6.2).** Throws `403 forbidden` unless the user holds `capability` (`"write"` = editor+, `"manage"` = project admin) on the project. The project-role dimension; pairs with the handler's existing `checkScope` (token dimension) — both must pass. Instance-wide actors bypass. |
| `effectivePermissions(user, token, projectId)` | Token scopes ∩ project role → `read`/`write`/`manage` capability set. **The single read-only convergence predicate (6.3):** a read-only `dashboard` token (capped scopes) and a `viewer`-role human both resolve here to a set without `write`. Enforcement still runs through the two gates below; this is the model they share. |

### List-read pattern

```ts
const conds: SQL[] = [isNull(schema.tickets.deleted_at)];
const scope = await visibleProjectFilter(auth.user, schema.tickets.project_id);
if (scope) conds.push(scope); // null = instance-wide, add nothing
// …other filters, cursor, etc. — counts + pagination stay correct.
```

### Detail-read pattern

```ts
const ticket = await resolveTicket(idOrKey); // existence as today
if (!ticket) throw notFound("ticket");
await assertProjectReadable(auth.user, ticket.project_id, "ticket"); // 404 for non-members
```

### Write pattern (6.2)

Keep the existing `checkScope` (token dimension) and add the role gate after the
project is resolved — both must pass, which *is* the `scope ∩ role` intersection.
Writes 403 (not 404); a non-member resolving the resource then hits the gate.

```ts
checkScope(c, "tickets:write");                                  // token dimension (unchanged)
const ticket = await resolveTicket(idOrKey);
await assertProjectRole(auth.user, ticket.project_id, "write", "ticket"); // role dimension → 403
```

Project-config writes (statuses, transitions, project edit) use `"manage"`.
Instance surfaces (rules, targets, webhooks, boards, labels, users, settings,
project *creation*) use `assertInstanceAdmin` instead — they're not project-
scoped. Custom fields branch on `project_id`: project-scoped → `assertProjectRole
(manage)`, global (`project_id NULL`) → `assertInstanceAdmin`.

## Rollout (6.1.x)

6.1.0 ships the primitives + this playbook + the matrix harness with **no
endpoint behavior change**. Enforcement is then wired per endpoint family:

- **6.1.0 — ✅ primitives + playbook + matrix harness.**
- **6.1.1 — ✅ ticket reads + inherited resources.** Scoped: `GET /v1/tickets`
  (list, via `visibleProjectFilter`), ticket detail / `events` / `children`,
  `GET /v1/tickets/{id}/comments`, ticket `links` + `external-refs`, and
  attachment `GET /v1/attachments/{id}` + `/meta` (resolved up to the parent
  ticket's project, including the `comment_id` → comment → ticket chain). Each
  non-member read returns `404`. The negative-access matrix now boots the real
  Hono app and drives these endpoints over HTTP as a viewer.
- **6.1.2 — ✅ project config reads.** Scoped: `GET /v1/projects` (list, via
  `visibleProjectFilter`) + `GET /v1/projects/{key}`; `statuses` + `transitions`
  lists; ticket `templates` list, `GET /v1/templates/{id}`, and its `instances`;
  `custom-fields` (`?project=` gated, unscoped list returns globals + visible
  projects' fields, `GET /v1/custom-fields/{id}` gated when project-scoped).
  Two deliberate carve-outs stay instance-wide: **labels** (a global catalog —
  `name` + `color`, no `project_id`, no project-identifying info) and **global
  custom fields** (`project_id NULL` — instance-wide config the ticket-create
  form needs; only *project-scoped* fields gate on membership).
- **6.1.3 — ✅ boards (cross-project column drop).** Boards are saved views over
  a many-to-many set of projects, so the single-column `visibleProjectFilter`
  doesn't apply — `boards.ts` builds on `visibleProjectIds` / `hasInstanceWideAccess`
  directly. A member sees a board iff they hold a membership on ≥1 of its
  projects; within a visible board they see only their own projects' refs +
  cards. `GET /v1/boards` (list) pushes an `EXISTS (board_projects ⋈ projects …)`
  predicate so pagination + `has_more` stay correct, then narrows each board's
  `projects[]`; `GET /v1/boards/{id}` and `/columns` intersect the board's
  projects with the member's and drive the card query off that filtered set.
  **Decision (the ticket left it open):** a board with **zero** projects the
  member can see — a single-project board for a non-member project, a
  cross-project board they're a member of none of, or a genuinely empty board —
  is **dropped from the list AND 404s on direct fetch** (never a
  visible-but-unloadable board). Instance-wide actors (owner/agent) are
  unaffected and still get empty boards as `200`. Swimlanes
  (project/assignee/epic/type) are computed client-side from the columns' cards,
  so the card filter is what guarantees a non-member project row never surfaces —
  there's no separate server-side swimlane to gate.
- **6.1.4 — ✅ aggregates & feeds.** Scoped: `GET /v1/events` (feed via
  `visibleProjectFilter`; explicit `?project=` a non-member can't see → 404), and
  all of `stats.ts` — `GET /v1/projects/{key}/stats` (`assertProjectReadable`),
  `/v1/stats/projects` (member-scoped bulk SQL), `/v1/stats/throughput`,
  `/v1/stats/cycle-time`, `/v1/stats/cumulative-flow` (a shared
  `resolveStatsScope` helper), and `/v1/stats/stale` (`visibleProjectFilter`).
  **The conflation fix:** the window endpoints previously used
  `projectIds.length === 0` to mean *both* "all projects" (instance-wide, no
  `?project=`) *and* "named keys, none matched" — for a zero-project member that
  branch leaked the whole instance. `resolveStatsScope` returns an explicit
  `{ projectIds, unfiltered }` where a member is **never** `unfiltered`, so a
  member with no visible projects gets empty aggregates, never all-data.
  **Already covered:** the search DSL (`?project=`/`assignee=`) was scoped in
  6.1.1 via the tickets list — matrix assertion only, no new code.
  **Deliberate carve-out:** `/v1/users/me/notifications` (+ unread-count) is
  **not** scoped — they're the user's own @-mentions, and hiding a notification
  for a ticket in a project they've left is the wrong kind of strictness
  (read-visibility is soft; write-isolation is the goal). `users.ts` therefore
  stays on the advisory `authz-guard` list intentionally; when 6.1.5 flips the
  guard to a failing gate it needs an allowlist entry for this carve-out.
- **6.1.5 — ✅ admin-surface audit.** Audited `rules.ts`, `targets.ts`,
  `webhooks.ts`, `settings.ts`, `users.ts`, `llmObservations.ts`. Findings +
  decisions:
  - **Admin infra → instance-admin only (403).** All **reads** on `rules`,
    `targets`, and `webhooks` (list / detail / `firings` / `deliveries`) now gate
    on `assertInstanceAdmin` — a `member` human gets `403`, owner + agents pass.
    These gate on **instance role**, not token scope, so an owner's read-only
    token still works and imperium-loop agents keep cross-project access. Rules
    carry a `project_id`, but their reads are *fully* instance-admin in 6.1.5
    (automation is a *manage* capability) — no project-member rules view; revisit
    in 6.2 if wanted. Writes stay on the `:manage` token scope until 6.2 realigns
    the write path onto instance role. (Transient wrinkle, never created by the
    intended deployment: a member holding a fluke `admin`-scoped token could
    *write* a rule but not *read* it back — 6.2 closes this by moving writes to
    instance role too.)
  - **`users.ts` directory policy → co-members, not the full roster.** A blanket
    directory leaks the roster; a blanket 403 breaks assignee / mention pickers.
    `GET /v1/users` is filtered to **co-members of the member's visible projects
    ∪ all agents ∪ self** (`visibleUserIds`); `GET /v1/users/{id}` returns `404`
    for anyone outside that set (a member can't probe the roster by enumerating
    ids). Owners without an explicit `user_projects` row on a shared project do
    **not** appear in a member's directory — acceptable under the co-member rule.
    Owner/agent see everyone.
  - **`GET /v1/users/{id}/tokens` → admin-only (gap fix).** It had **no** scope
    check, leaking token metadata (name / prefix / scopes) for any user to any
    caller. Now `checkScope("users:manage")`, matching its `createToken` /
    `revokeToken` siblings.
  - **`settings.ts` → deliberate carve-out.** `GET /v1/settings` stays readable
    by any authenticated user — it's non-secret global *display* config
    (`stale_in_progress_days`, `board_closed_window_days`) the member UI needs to
    render stale badges / board windows, same reasoning as the 6.1.2 labels /
    global-fields carve-out. `PATCH /v1/settings` remains `admin`.
  - **`llmObservations.ts` → no change.** Write-only (`POST`, `llm-obs:write`);
    no read path to leak.
  - **Guard flipped.** `authz-guard.ts` is now `ENFORCE = true` and runs as a
    `ci.yml` step; `assertInstanceAdmin` + `visibleUserIds` were added to its
    helper allowlist. Both previously-flagged files (`rules.ts`, `users.ts`) now
    reference a helper, so the gate is green.

## Rollout (6.2)

- **6.2 — ✅ write-path enforcement + roles.** Every mutating handler now gates
  on the project-role dimension on top of its existing `checkScope`. Wiring by
  family:
  - **Project-scoped writes → `assertProjectRole(…, "write")` (editor+):**
    tickets (create / update / delete / transition; **move** requires write on
    *both* source and destination), comments (create / update / delete — the
    author-only check stays), attachments (upload / delete; an orphan attachment
    with no parent ticket is instance-admin only), ticket links + external-refs,
    and **ticket templates** (create / update / delete / fire_now).
  - **Project-config writes → `assertProjectRole(…, "manage")` (project admin):**
    project edit / archive / delete, statuses + transitions (create / update /
    delete / reorder), and project-scoped custom fields.
  - **Instance surfaces → `assertInstanceAdmin`:** project **creation** (a
    project admin can't mint projects), boards, rules, targets, webhooks, labels,
    users + API tokens, settings `PATCH`, and global (`project_id NULL`) custom
    fields. These keep their existing `:manage`/`admin` token-scope check too.
  - **Self-scoped, unchanged:** saved views (owner-only) and
    `POST /v1/users/me/notifications/mark-read` (self).
  - **Effective = token scope ∩ project role**, enforced as a conjunction of two
    gates (`checkScope` + `assertProjectRole`) rather than via
    `effectivePermissions`, so per-scope precision survives (a `comments:write`
    token still can't create tickets). `checkScope`'s `admin`-scope short-circuit
    is instance-admin; project-admin comes from the role gate — that's the
    "split instance-admin from project-admin" the ticket asked for.
  - **Templates decision:** the ticket grouped templates under project-admin
    config, but they ship as **editor-tier** (`"write"`) — they're ticket-
    adjacent (recurring ticket creation, already `tickets:write`), so an editor
    who writes tickets can manage templates. SWY-102 was corrected to match.
  - **Guard extended to writes** (rule 7); negative-access matrix gained a
    `6.2 — write-path enforcement` block (viewer blocked even with a broad token;
    editor writes tickets not config; project admin configs own project not
    others; instance surfaces 403 for project admins; owner/agent regression).

## Rollout (6.3)

- **6.3 — ✅ read-only (dashboard) tokens + viewer convergence.** Adds a `kind`
  enum to tokens (`personal | agent | dashboard`, default `personal`; existing
  rows backfill to `personal`). `agent` is descriptive-only — agent-ness still
  derives from `users.type`. Only `dashboard` carries enforced behavior:
  - **Read-only by construction.** Creating a `dashboard` token caps its scopes
    to the read-only bundle (`READ_ONLY_SCOPES` in `shared/`, just `tickets:read`
    today). Omit `scopes` and the bundle is filled; pass a write scope and the
    handler returns `400 bad_request` with `details.reason =
    "invalid_scopes_for_kind"`. (Validated in the handler, not a Zod refinement,
    so the error uses the structured envelope. There is no token-update endpoint,
    so the read-only guarantee can't drift after creation.)
  - **One read-only predicate, not two.** A dashboard token is read-only via its
    *scopes*; a `viewer`-role human is read-only via their *role*.
    `effectivePermissions` (scope ∩ role) is the single predicate both resolve
    through — neither path needs a new write-blocking mechanism. Enforcement
    remains the existing two gates: `checkScope` already 403s a capped token's
    write (no `tickets:write`), and `assertProjectRole` already 403s a viewer.
  - **Read surface follows the owning user.** A dashboard token reads whatever
    its user can see — instance-wide for an owner/agent, project-scoped for a
    member. A scoped public demo = a dashboard token on a `viewer` user (manual
    setup; see [agents.md](./agents.md)).
  - **Error-code note:** the ticket asked for an `invalid_scopes_for_kind` error
    *code*; `ErrorCode` is a closed HTTP-aligned enum, so the signal ships as
    `bad_request` + a stable `details.reason` discriminator instead. SWY-74 was
    corrected (also dropped its "optional expiry" line — tokens have no expiry
    column).

**Intentional non-goal (read visibility is soft):** a ticket you *can* see may
link to a ticket in a project you can't — the link list still surfaces that
ticket's key + title. Cross-project relationship metadata is visible by design;
only a *direct* fetch of the linked ticket 404s. The strictness budget is spent
on write isolation (6.2), not on hiding the existence of related work.
