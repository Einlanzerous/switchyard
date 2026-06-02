// Pure ticket-key parsers for the GitHub webhook receiver. Kept in their own
// module — free of any db/env imports — so they're unit-testable without a
// database (CI's `test:unit` has no DATABASE_URL). githubWebhook.ts imports
// and re-exports these alongside the db-backed handler.
//
//   1. parseKeyMentions — pull `KEY-N` ticket keys out of free-form text
//      (PR titles, branch names) with the project-key shape rules the rest
//      of the codebase uses.
//   2. parseClosingKeyMentions — closing-keyword-scoped variant for PR
//      bodies (SWY-81).

// PROJECT_KEY (per shared/schemas/common.ts) is `^[A-Z][A-Z0-9]{1,9}$`.
// Inside text, a mention is delimited so we don't catch substrings of
// longer alphanumeric runs. Tail is letters/digits only (no trailing
// hyphen consumed); leading boundary forbids alphanumeric immediately
// before the prefix so e.g. "ABBSWY-1" doesn't match.
const KEY_TAIL_RE = /[A-Z][A-Z0-9]{1,9}-\d+/g;

export function parseKeyMentions(text: string, prefix: string): string[] {
  if (!text) return [];
  // Compile per call — the prefix is cheap to scan and rarely changes.
  // When prefix === "*" we accept any project-key shape; otherwise
  // require the literal prefix at the start of the key.
  const wildcard = prefix === "*";
  const out = new Set<string>();
  for (const match of text.matchAll(KEY_TAIL_RE)) {
    const key = match[0]!;
    if (!wildcard && !key.startsWith(prefix + "-")) continue;
    // Reject when the char immediately before the match is alphanumeric
    // (avoids matching ABBSWY-1 → SWY-1 when prefix=SWY).
    const idx = match.index ?? 0;
    if (idx > 0 && /[A-Za-z0-9]/.test(text[idx - 1] ?? "")) continue;
    out.add(key);
  }
  return [...out];
}

// Closing-keyword scan for PR *bodies* (SWY-81). Unlike titles and branch
// names — which are terse and rarely name a ticket the PR doesn't touch —
// PR bodies are free-form prose that frequently *mention* a key in passing
// ("similar to what we did in SWY-42", a "Related:" footer). Attaching on a
// bare body mention would let the SWY-69 auto-close-on-merge rule close a
// ticket the PR never fixed. So in bodies we only honor keys introduced by
// an explicit closing keyword, mirroring GitHub's own `Closes <ref>`
// semantics; title/branch parsing keeps matching bare keys.
//
// This is what catches the "super PR" pattern: one PR that closes several
// tickets lists them in the body (`Closes A, B, C`), not the title/branch.
const CLOSING_KEYWORDS = "close[sd]?|fix(?:e[sd])?|resolve[sd]?|references?|refs?";
const KEY_TOKEN = "[A-Z][A-Z0-9]{1,9}-\\d+";
// A keyword, an optional colon, then a comma / "and" / "&"-separated list of
// keys. The list is captured loosely and handed back to parseKeyMentions so
// prefix filtering, the `*` wildcard, and the ABBSWY-1 boundary guard stay
// identical to title/branch handling.
const CLOSING_LIST_RE = new RegExp(
  `\\b(?:${CLOSING_KEYWORDS})\\b\\s*:?\\s+(${KEY_TOKEN}(?:\\s*(?:,|&|and)\\s*${KEY_TOKEN})*)`,
  "gi",
);

export function parseClosingKeyMentions(body: string, prefix: string): string[] {
  if (!body) return [];
  const out = new Set<string>();
  for (const m of body.matchAll(CLOSING_LIST_RE)) {
    for (const key of parseKeyMentions(m[1] ?? "", prefix)) out.add(key);
  }
  return [...out];
}
