// Cached rules-engine identity, resolved once at dispatcher boot.
//
// Extracted into its own leaf module to break the import cycle
//   events.ts → rules/dispatcher.ts → rules/actions.ts → events.ts
// events.ts needs only getRulesEngineUserId() (to skip rule fan-out for
// rule-authored events); importing it from the dispatcher created the
// back-edge that closed the cycle. This module is imported by both events.ts
// and the dispatcher and depends on neither, so the graph stays a DAG.

import type { UserRef } from "@switchyard/shared";

// The rule dispatcher needs the rules-engine user row to attribute actions;
// it's cached once at boot instead of looked up per firing.
let rulesEngineUserId: string | null = null;
let rulesEngineActor: UserRef | null = null;

export function setRulesEngineContext(userId: string, actor: UserRef): void {
  rulesEngineUserId = userId;
  rulesEngineActor = actor;
}

// Used by lib/events.ts to skip rule fan-out for rule-authored events.
export function getRulesEngineUserId(): string | null {
  return rulesEngineUserId;
}

export function getRulesEngineActor(): UserRef | null {
  return rulesEngineActor;
}

// Test-only: drop the cached bootstrap state so the next startDispatcher()
// re-resolves the rules-engine user. Used by integration tests that
// TRUNCATE users between cases — without it the dispatcher keeps writing
// events with a now-deleted actor_id and hits an FK violation.
export function resetRulesEngineContext(): void {
  rulesEngineUserId = null;
  rulesEngineActor = null;
}
