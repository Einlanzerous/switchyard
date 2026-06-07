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
   with a role check — existence isn't a secret once you're already acting on a
   resource you can see. (Write enforcement is 6.2.)

5. **Owner/agent bypass is one predicate.** `hasInstanceWideAccess`, explicit
   and tested. Never re-derive it.

6. **Every read-endpoint PR extends the negative-access matrix.** When you scope
   an endpoint, add a block to `server/test/integration/negative-access.test.ts`
   asserting the `friend` viewer gets 404 on detail reads of non-member projects
   and never sees their rows in list reads. A new scoped read without a matrix
   row fails review.

7. **CI grep-guard.** `server/scripts/authz-guard.ts` flags route handlers that
   query `tickets` / `projects` / `boards` without routing through an authz
   helper. **Advisory in 6.1.0** (it would flag every handler today — nothing is
   scoped yet); flip it to a failing `ci.yml` gate once 6.1.5 completes. Run it
   any time with `bun server/scripts/authz-guard.ts`.

## Helper API (`server/src/lib/authz.ts`)

| Helper | Use |
|---|---|
| `hasInstanceWideAccess(user)` | The single owner/agent bypass predicate. |
| `visibleProjectIds(user)` | Set of project ids the user may see (all live projects for instance-wide actors). |
| `visibleProjectFilter(user, projectIdCol)` | **List reads.** Returns a `WHERE` predicate for `conds[]`: `null` for instance-wide (no filter), `project_id IN (…)` for members, a `FALSE` predicate for a member with zero projects (empty page, pagination intact). |
| `canSeeProject(user, projectId)` | Boolean membership check; cheaper than `visibleProjectIds` for a single resource. |
| `assertProjectReadable(user, projectId, resource)` | **Detail reads.** Throws `404 not_found` for non-members; resolves for members + instance-wide actors. |
| `effectivePermissions(user, token, projectId)` | Token scopes ∩ project role → `read`/`write`/`manage` capability set. The basis for 6.2 write enforcement. |

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
- 6.1.4 aggregates & feeds, 6.1.5 admin-surface audit.

Write-path enforcement + role mapping is 6.2.

**Intentional non-goal (read visibility is soft):** a ticket you *can* see may
link to a ticket in a project you can't — the link list still surfaces that
ticket's key + title. Cross-project relationship metadata is visible by design;
only a *direct* fetch of the linked ticket 404s. The strictness budget is spent
on write isolation (6.2), not on hiding the existence of related work.
