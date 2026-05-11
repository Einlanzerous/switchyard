# Graph Report - .  (2026-05-10)

## Corpus Check
- Large corpus: 296 files · ~176,326 words. Semantic extraction will be expensive (many Claude tokens). Consider running on a subfolder, or use --no-semantic to run AST-only.

## Summary
- 1026 nodes · 1504 edges · 228 communities (193 shown, 35 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 12 edges (avg confidence: 0.79)
- Token cost: 9,800 input · 4,200 output

## Community Hubs (Navigation)
- [[_COMMUNITY_Client State Composables|Client State Composables]]
- [[_COMMUNITY_Server Middleware & Health|Server Middleware & Health]]
- [[_COMMUNITY_Database Schema|Database Schema]]
- [[_COMMUNITY_Analytics & Cycle Time|Analytics & Cycle Time]]
- [[_COMMUNITY_Cursor Pagination|Cursor Pagination]]
- [[_COMMUNITY_Event Sourcing & Audit|Event Sourcing & Audit]]
- [[_COMMUNITY_API Route Helpers|API Route Helpers]]
- [[_COMMUNITY_Test Utilities|Test Utilities]]
- [[_COMMUNITY_Database Row Types|Database Row Types]]
- [[_COMMUNITY_File Storage Layer|File Storage Layer]]
- [[_COMMUNITY_Attachments & Comments|Attachments & Comments]]
- [[_COMMUNITY_Entity Resolution|Entity Resolution]]
- [[_COMMUNITY_Stats & Metrics Types|Stats & Metrics Types]]
- [[_COMMUNITY_Vue Router & Views|Vue Router & Views]]
- [[_COMMUNITY_Shared API Types|Shared API Types]]
- [[_COMMUNITY_Integration Test Helpers|Integration Test Helpers]]
- [[_COMMUNITY_Data Mappers|Data Mappers]]
- [[_COMMUNITY_API Token Management|API Token Management]]
- [[_COMMUNITY_Project & Status CRUD|Project & Status CRUD]]
- [[_COMMUNITY_E2E Test Suite|E2E Test Suite]]
- [[_COMMUNITY_Board Domain Types|Board Domain Types]]
- [[_COMMUNITY_Ticket List View|Ticket List View]]
- [[_COMMUNITY_Architecture Decisions|Architecture Decisions]]
- [[_COMMUNITY_Bulk Operations|Bulk Operations]]
- [[_COMMUNITY_Token & Secret Crypto|Token & Secret Crypto]]
- [[_COMMUNITY_Notifications System|Notifications System]]
- [[_COMMUNITY_Test Seed & Setup|Test Seed & Setup]]
- [[_COMMUNITY_Mention Detection|Mention Detection]]
- [[_COMMUNITY_Docker Infrastructure|Docker Infrastructure]]
- [[_COMMUNITY_Saved Views|Saved Views]]
- [[_COMMUNITY_Auth Middleware|Auth Middleware]]
- [[_COMMUNITY_Status Transitions|Status Transitions]]
- [[_COMMUNITY_Settings UI|Settings UI]]
- [[_COMMUNITY_Board View|Board View]]
- [[_COMMUNITY_Filter Dropdown UI|Filter Dropdown UI]]
- [[_COMMUNITY_Label Management|Label Management]]
- [[_COMMUNITY_OpenAPI Specification|OpenAPI Specification]]
- [[_COMMUNITY_Project Creation UI|Project Creation UI]]
- [[_COMMUNITY_Activity Feed|Activity Feed]]
- [[_COMMUNITY_Notifications UI|Notifications UI]]
- [[_COMMUNITY_App Shell Navigation|App Shell Navigation]]
- [[_COMMUNITY_App Bootstrap|App Bootstrap]]
- [[_COMMUNITY_Search DSL Parser|Search DSL Parser]]
- [[_COMMUNITY_Saved Views UI|Saved Views UI]]
- [[_COMMUNITY_Comment Composer|Comment Composer]]
- [[_COMMUNITY_Dashboard E2E Tests|Dashboard E2E Tests]]
- [[_COMMUNITY_DB Test Setup|DB Test Setup]]
- [[_COMMUNITY_Event Write Layer|Event Write Layer]]
- [[_COMMUNITY_Feature Highlights|Feature Highlights]]
- [[_COMMUNITY_Frontend Tech Stack|Frontend Tech Stack]]
- [[_COMMUNITY_Static File Server|Static File Server]]
- [[_COMMUNITY_Health Dashboard|Health Dashboard]]
- [[_COMMUNITY_Label Settings UI|Label Settings UI]]
- [[_COMMUNITY_Project Board View|Project Board View]]
- [[_COMMUNITY_Avatar Color Utils|Avatar Color Utils]]
- [[_COMMUNITY_Assignee Leaderboard|Assignee Leaderboard]]
- [[_COMMUNITY_Keyboard Shortcuts|Keyboard Shortcuts]]
- [[_COMMUNITY_Automation Roadmap|Automation Roadmap]]
- [[_COMMUNITY_E2E Auth Setup|E2E Auth Setup]]
- [[_COMMUNITY_Bulk E2E Tests|Bulk E2E Tests]]
- [[_COMMUNITY_Tickets E2E Tests|Tickets E2E Tests]]
- [[_COMMUNITY_Avatar Variants|Avatar Variants]]
- [[_COMMUNITY_Command Context|Command Context]]
- [[_COMMUNITY_Board Cell Drag|Board Cell Drag]]
- [[_COMMUNITY_Board Column Drag|Board Column Drag]]
- [[_COMMUNITY_Bulk Transition UI|Bulk Transition UI]]
- [[_COMMUNITY_Mention Autocomplete|Mention Autocomplete]]
- [[_COMMUNITY_smoke.spec.ts|smoke.spec.ts]]
- [[_COMMUNITY_board.spec.ts|board.spec.ts]]
- [[_COMMUNITY_theme.ts|theme.ts]]
- [[_COMMUNITY_ui.ts|ui.ts]]
- [[_COMMUNITY_index.ts|index.ts]]
- [[_COMMUNITY_buttonVariants|buttonVariants]]
- [[_COMMUNITY_badgeVariants|badgeVariants]]
- [[_COMMUNITY_CumulativeFlowChart.vue|CumulativeFlowChart.vue]]
- [[_COMMUNITY_ThroughputChart.vue|ThroughputChart.vue]]
- [[_COMMUNITY_CreateTicketDialog.vue|CreateTicketDialog.vue]]
- [[_COMMUNITY_FilterBar.vue|FilterBar.vue]]
- [[_COMMUNITY_StatusBadge.vue|StatusBadge.vue]]
- [[_COMMUNITY_BoardCard.vue|BoardCard.vue]]
- [[_COMMUNITY_Actor Model (users table with type=agent|Actor Model (users table with type=agent]]
- [[_COMMUNITY_Client index.html (Vue App Entry Point)|Client index.html (Vue App Entry Point)]]
- [[_COMMUNITY_Changelog v2.0.0 — Publish Containers (B|Changelog v2.0.0 — Publish Containers (B]]
- [[_COMMUNITY_Changelog v1.2.1 — Test Cleanup and View|Changelog v1.2.1 — Test Cleanup and View]]
- [[_COMMUNITY_Changelog v1.2.0 — Phase 3.3, Playwright|Changelog v1.2.0 — Phase 3.3, Playwright]]
- [[_COMMUNITY_Changelog v1.1.0 — Stats Endpoints, Labe|Changelog v1.1.0 — Stats Endpoints, Labe]]
- [[_COMMUNITY_Changelog v1.0.0 — Boards, Auth, Tickets|Changelog v1.0.0 — Boards, Auth, Tickets]]
- [[_COMMUNITY_Ticket ID Format (KEY-NUMBER)|Ticket ID Format (KEY-NUMBER)]]
- [[_COMMUNITY_switchyard_user (PostgreSQL Role)|switchyard_user (PostgreSQL Role)]]

## God Nodes (most connected - your core abstractions)
1. `db` - 23 edges
2. `badRequest()` - 18 edges
3. `notFound()` - 17 edges
4. `Uuid` - 16 edges
5. `requireAuth()` - 16 edges
6. `Switchyard` - 15 edges
7. `errorResponses` - 14 edges
8. `okJson()` - 14 edges
9. `mapUserRef()` - 11 edges
10. `mapTicketSummary()` - 11 edges

## Surprising Connections (you probably didn't know these)
- `Idempotency Keys (24h TTL)` --semantically_similar_to--> `Bootstrap Token UX`  [INFERRED] [semantically similar]
  README.md → PHASES.md
- `id()` --calls--> `Uuid`  [INFERRED]
  server/drizzle/schema.ts → shared/src/schemas/common.ts
- `requireAuth()` --calls--> `next`  [INFERRED]
  server/src/auth.ts → client/src/components/tickets/BulkActionBar.vue
- `accessLog()` --calls--> `next`  [INFERRED]
  server/src/lib/access-log.ts → client/src/components/tickets/BulkActionBar.vue
- `Watchtower Opt-Out` --conceptually_related_to--> `/healthz Health Endpoint`  [INFERRED]
  docker-compose.yaml → README.md

## Hyperedges (group relationships)
- **Agent-First API Design Pattern (idempotency + cursor pagination + bearer token auth)** — readme_bearer_token_auth, readme_idempotency_keys, readme_cursor_pagination, readme_error_envelope [EXTRACTED 0.95]
- **Two-Container Deploy (backend + frontend on construct_net)** — compose_switchyard_backend, compose_switchyard_frontend, compose_construct_net [EXTRACTED 0.95]
- **Playwright E2E Test Suite (smoke + tickets + bulk + board + dashboard)** — e2e_smoke_spec, e2e_tickets_spec, e2e_bulk_spec, e2e_board_spec, e2e_dashboard_spec [EXTRACTED 0.95]

## Communities (228 total, 35 thin omitted)

### Community 0 - "Client State Composables"
Cohesion: 0.05
Nodes (22): BoardStatusLookup, ProjectStatusMap, useHasUnread(), useUnreadCount(), BoardColumn, CATEGORY_ORDER, FilterKey, TicketFilters (+14 more)

### Community 1 - "Server Middleware & Health"
Cohesion: 0.06
Nodes (39): accessLog(), QUIET_PATHS, buildHealthReport(), HealthReport, probeDb(), probeUploads(), probeWebhookQueue(), SubsystemStatus (+31 more)

### Community 2 - "Database Schema"
Cohesion: 0.05
Nodes (36): apiTokens, attachmentKind, attachments, boardLayout, boardProjects, boards, comments, events (+28 more)

### Community 3 - "Analytics & Cycle Time"
Cohesion: 0.09
Nodes (26): bucketEnds(), buildCycleTimeSamples(), buildTimelines(), categoryAt(), CategoryCountsLike, ClosedTicketInfo, computeCumulativeFlow(), computeInProgressMs() (+18 more)

### Community 4 - "Cursor Pagination"
Cohesion: 0.09
Nodes (24): buildPage(), Cursor, cursorOrderBy(), cursorWhere(), decodeCursor(), encodeCursor(), c, decoded (+16 more)

### Community 5 - "Event Sourcing & Audit"
Cohesion: 0.11
Nodes (21): Event, EventChanges, EventType, FieldChange, StatusChange, CreateStatus, ReorderStatuses, Resolution (+13 more)

### Community 6 - "API Route Helpers"
Cohesion: 0.14
Nodes (17): list, createdJson(), errorResponses, okJson(), scope(), create, list, mount() (+9 more)

### Community 7 - "Test Utilities"
Cohesion: 0.13
Nodes (12): Captured, captures, parsed, signHmac(), body, sig, verifyHmac(), names (+4 more)

### Community 8 - "Database Row Types"
Cohesion: 0.1
Nodes (20): AttachmentRow, CommentRow, EventPayload, EventRow, LabelRow, mapEvent(), mapLabel(), mapProject() (+12 more)

### Community 9 - "File Storage Layer"
Cohesion: 0.15
Nodes (19): buildStoragePath(), checkSizeCap(), ResolvedSniff, resolveSniff(), safeResolve(), sniff(), Sniffed, sniffText() (+11 more)

### Community 10 - "Attachments & Comments"
Cohesion: 0.15
Nodes (17): Attachment, AttachmentKind, CreateAttachmentForm, Comment, CreateComment, UpdateComment, SoftDeletable, CreateTicket (+9 more)

### Community 11 - "Entity Resolution"
Cohesion: 0.14
Nodes (18): getProjectById(), getProjectByKey(), getStatusById(), getUserById(), resolveTicket(), children, create, events (+10 more)

### Community 12 - "Stats & Metrics Types"
Cohesion: 0.1
Nodes (19): AssigneeCount, CategoryCounts, CumulativeFlowPoint, CumulativeFlowStats, CycleTimeByType, CycleTimeSample, CycleTimeStats, PriorityCounts (+11 more)

### Community 13 - "Vue Router & Views"
Cohesion: 0.1
Nodes (3): canCreate, body, body

### Community 14 - "Shared API Types"
Cohesion: 0.14
Nodes (15): Cursor, ErrorCode, ErrorEnvelope, HexColor, IdempotencyKey, PageMeta, TicketKey, Timestamps (+7 more)

### Community 15 - "Integration Test Helpers"
Cohesion: 0.16
Nodes (17): ago(), client, db, ensureProject(), loadStatuses(), main(), materializeTicket(), Milestone (+9 more)

### Community 16 - "Data Mappers"
Cohesion: 0.16
Nodes (17): mapAttachment(), mapComment(), mapProjectRef(), mapStatusRef(), mapTicket(), mapTicketSummary(), mapUserRef(), TicketSummaryDeps (+9 more)

### Community 17 - "API Token Management"
Cohesion: 0.12
Nodes (14): mapApiToken(), mapUser(), create, createToken, get, list, listTokens, markNotificationsRead (+6 more)

### Community 18 - "Project & Status CRUD"
Cohesion: 0.17
Nodes (10): rejectCollision(), create, DEFAULT_STATUSES, get, list, remove, update, catchUnique() (+2 more)

### Community 19 - "E2E Test Suite"
Cohesion: 0.15
Nodes (16): bulk.spec.ts (E2E Bulk Operations Tests), .github/workflows/e2e.yml (E2E CI Workflow), dashboard.spec.ts (E2E Dashboard Tests), Playwright E2E Suite README, smoke.spec.ts (E2E Smoke Tests), TEST Project (Read-Only E2E Fixtures), tickets.spec.ts (E2E Filter DSL + Saved View Tests), Bulk Operations (multi-select, bulk-edit) (+8 more)

### Community 20 - "Board Domain Types"
Cohesion: 0.14
Nodes (13): Board, BoardColumns, BoardFilter, BoardLayout, CreateBoard, UpdateBoard, ProjectKey, CreateProject (+5 more)

### Community 21 - "Ticket List View"
Cohesion: 0.13
Nodes (11): allOnPageSelected, errMessage, focusedKey, { items, isLoading, isFetchingNextPage, hasNextPage, fetchNextPage, error }, route, router, rowVirtualizer, selectedTickets (+3 more)

### Community 22 - "Architecture Decisions"
Cohesion: 0.15
Nodes (15): auth.setup.ts (E2E Auth Fixture), Epic Hierarchy (One Level Deep), Phase 0 — Contract & Scaffold, Resolution Field (done|released|cancelled), Bearer Token Authentication, Cursor Pagination (updated_at, id pairs), Drizzle ORM, /healthz Health Endpoint (+7 more)

### Community 23 - "Bulk Operations"
Cohesion: 0.15
Nodes (8): idempotency(), CATEGORIES, columns, create, list, remove, update, next

### Community 24 - "Token & Secret Crypto"
Cohesion: 0.28
Nodes (11): base32Encode(), generateApiToken(), generateWebhookSecret(), hashToken(), main(), CANONICAL_USERS, CanonicalUser, ensureBootstrapToken() (+3 more)

### Community 25 - "Notifications System"
Cohesion: 0.17
Nodes (11): paginated(), Pagination, ListNotificationsQuery, MarkReadInput, Notification, NotificationKind, NotificationPayload, NotificationSource (+3 more)

### Community 26 - "Test Seed & Setup"
Cohesion: 0.24
Nodes (11): client, db, ensureProject(), ensureTestUser(), main(), nextNumber(), pruneStaleE2eSavedViews(), SeedTicket (+3 more)

### Community 27 - "Mention Detection"
Cohesion: 0.27
Nodes (11): detectAndNotify(), detectAndNotifyOnEdit(), escapeRegex(), extractMentionedNames(), MentionSource, NotificationKind, resolveMentionedUsers(), snippetAround() (+3 more)

### Community 28 - "Docker Infrastructure"
Cohesion: 0.26
Nodes (12): construct_net (External Docker Network), construct-server Docker Stack, Construct-Server Integration Runbook, switchyard (Backend Container Service), switchyard-frontend (Frontend Container Service), switchyard_uploads (Named Volume for Attachments), Watchtower Opt-Out, Two-Container Split (Backend API + Frontend Static) (+4 more)

### Community 29 - "Saved Views"
Cohesion: 0.18
Nodes (9): Iso8601, CreateSavedView, SavedView, SavedViewFilters, SavedViewScope, UpdateSavedView, SystemSettingKey, SystemSettings (+1 more)

### Community 30 - "Auth Middleware"
Cohesion: 0.31
Nodes (9): checkScope(), stub(), AuthContext, ContextVariableMap, requireAuth(), requireScope(), forbidden(), notImplemented() (+1 more)

### Community 31 - "Status Transitions"
Cohesion: 0.18
Nodes (9): mapStatus(), create, createTransition, list, listTransitions, remove, removeTransition, reorder (+1 more)

### Community 32 - "Settings UI"
Cohesion: 0.2
Nodes (7): createMutation, items, newName, revokedCount, revokeMutation, showCreate, showRevoked

### Community 33 - "Board View"
Cohesion: 0.22
Nodes (7): ColumnsResponse, found, key, projectMap, targetProject, targetStatus, ticket

### Community 34 - "Filter Dropdown UI"
Cohesion: 0.22
Nodes (6): dropdownVisible, filtered, focused, search, selected, selectedSet

### Community 35 - "Label Management"
Cohesion: 0.22
Nodes (7): noContent, create, list, remove, update, UserRow, ViewRow

### Community 36 - "OpenAPI Specification"
Cohesion: 0.22
Nodes (9): API Error Schema (code + message + details), Switchyard OpenAPI Specification, GET /v1/users — List Users, Bootstrap Token UX, Phase 1 — Backend MVP, TypeScript Client Codegen (api.types.ts), Webhook Dispatcher (In-Process Polling Loop), Structured Error Envelope (+1 more)

### Community 37 - "Project Creation UI"
Cohesion: 0.25
Nodes (7): canCreate, createMutation, newDescription, newKey, newName, qc, validKey

### Community 38 - "Activity Feed"
Cohesion: 0.25
Nodes (5): items, params, q, route, router

### Community 39 - "Notifications UI"
Cohesion: 0.29
Nodes (3): listQ, markAll, markOne

### Community 40 - "App Shell Navigation"
Cohesion: 0.33
Nodes (4): activeKey, admin, isActive(), for()

### Community 42 - "Search DSL Parser"
Cohesion: 0.4
Nodes (4): ParsedQuery, parseSearchQuery(), tokenize(), VALUE_KEYS

### Community 44 - "Comment Composer"
Cohesion: 0.33
Nodes (4): fd, kind, token, trimmed

### Community 45 - "Dashboard E2E Tests"
Cohesion: 0.4
Nodes (4): canvases, card, labels, select

### Community 46 - "DB Test Setup"
Cohesion: 0.4
Nodes (4): client, db, migrationsFolder, triggersFile

### Community 47 - "Event Write Layer"
Cohesion: 0.4
Nodes (3): Tx, writeEvent(), WriteEventInput

### Community 48 - "Feature Highlights"
Cohesion: 0.5
Nodes (5): board.spec.ts (E2E Board Tests), Command Palette (Ctrl+K), Kanban Board (pragmatic-drag-and-drop), Phase 2 — Frontend, Search-as-DSL Filter Syntax

### Community 49 - "Frontend Tech Stack"
Cohesion: 0.4
Nodes (5): Pinia (State Management), shadcn-vue Component Library, Tailwind CSS, TanStack Query, Vue 3 + Vite + TypeScript Client

### Community 51 - "Health Dashboard"
Cohesion: 0.5
Nodes (3): overallStatus, uploads, webhooks

### Community 52 - "Label Settings UI"
Cohesion: 0.5
Nodes (3): body, canSave, validHex

### Community 53 - "Project Board View"
Cohesion: 0.5
Nodes (3): key, targetCol, TicketsResponse

### Community 54 - "Avatar Color Utils"
Cohesion: 0.67
Nodes (3): AVATAR_PALETTE, avatarColorFor(), hash()

### Community 55 - "Assignee Leaderboard"
Cohesion: 0.5
Nodes (3): max, q, top

### Community 57 - "Automation Roadmap"
Cohesion: 0.5
Nodes (4): n8n (Workflow Automation), Native Automation Rules Engine, Phase 4 — Native Automation Rules, Phase 5 — As Demanded (Future)

## Knowledge Gaps
- **426 isolated node(s):** `SavedViewFilters`, `SavedViewScope`, `SavedView`, `CreateSavedView`, `UpdateSavedView` (+421 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **35 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `Uuid` connect `Shared API Types` to `Database Schema`, `Event Sourcing & Audit`, `Attachments & Comments`, `Stats & Metrics Types`, `Board Domain Types`, `Notifications System`, `Saved Views`?**
  _High betweenness centrality (0.112) - this node is a cross-community bridge._
- **Why does `id()` connect `Database Schema` to `Shared API Types`?**
  _High betweenness centrality (0.111) - this node is a cross-community bridge._
- **Why does `db` connect `API Route Helpers` to `Server Middleware & Health`, `Analytics & Cycle Time`, `Cursor Pagination`, `Label Management`, `File Storage Layer`, `Entity Resolution`, `Event Write Layer`, `Data Mappers`, `API Token Management`, `Project & Status CRUD`, `Bulk Operations`, `Token & Secret Crypto`, `Mention Detection`, `Auth Middleware`, `Status Transitions`?**
  _High betweenness centrality (0.010) - this node is a cross-community bridge._
- **What connects `SavedViewFilters`, `SavedViewScope`, `SavedView` to the rest of the system?**
  _426 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Client State Composables` be split into smaller, more focused modules?**
  _Cohesion score 0.05 - nodes in this community are weakly interconnected._
- **Should `Server Middleware & Health` be split into smaller, more focused modules?**
  _Cohesion score 0.06 - nodes in this community are weakly interconnected._
- **Should `Database Schema` be split into smaller, more focused modules?**
  _Cohesion score 0.05 - nodes in this community are weakly interconnected._