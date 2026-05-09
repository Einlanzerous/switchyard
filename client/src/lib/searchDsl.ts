// Lightweight search-as-DSL parser for the tickets filter bar.
//
// Splits a single text input into structured filter slots so users can type
// `bug project=FLOW assignee=me priority=high "needs review"` instead of
// fishing through dropdowns. Bare words (and quoted phrases) accumulate into
// the free-text search; recognized `key=value` tokens land in their slot.
//
// Recognized keys: project, assignee. Type / status / priority remain chip
// groups in the FilterBar, since they're enum-bounded and easier to toggle
// visually than to type. Unknown keys (or `type=bug`-style tokens) are
// treated as bare text so they show up in the API's text search rather than
// silently disappearing.
//
// The parser is intentionally permissive — we don't validate values against
// the catalog here. The UI can flag unknown projects/users separately, and
// the API will simply return zero results for nonsense values.
//
// Future: autocomplete popover that suggests known projects/users when the
// caret sits after `project=` / `assignee=`. Currently deferred.

export type ParsedQuery = {
  text: string | undefined;
  project: string[];
  assignee: string | undefined;
};

const VALUE_KEYS = new Set(["project", "assignee"]);

// Tokenize the input respecting double-quoted phrases. A quoted phrase is
// always treated as a single bare-text token, even if it contains `=` or
// spaces. Backslash-escaping inside quotes is supported (`\"`, `\\`).
function tokenize(input: string): string[] {
  const out: string[] = [];
  let i = 0;
  const s = input;
  while (i < s.length) {
    const ch = s[i]!;
    if (ch === " " || ch === "\t") { i++; continue; }
    if (ch === '"') {
      let j = i + 1;
      let buf = "";
      while (j < s.length && s[j] !== '"') {
        if (s[j] === "\\" && j + 1 < s.length) { buf += s[j + 1]; j += 2; continue; }
        buf += s[j]!;
        j++;
      }
      out.push(buf);
      i = (j < s.length ? j + 1 : j);
      continue;
    }
    let j = i;
    while (j < s.length && s[j] !== " " && s[j] !== "\t") j++;
    out.push(s.slice(i, j));
    i = j;
  }
  return out;
}

export function parseSearchQuery(input: string): ParsedQuery {
  const result: ParsedQuery = {
    text: undefined,
    project: [],
    assignee: undefined,
  };
  const textParts: string[] = [];

  for (const tok of tokenize(input)) {
    const eq = tok.indexOf("=");
    // Anything without `=`, or starting with `=` (no key), is bare text.
    if (eq <= 0) {
      if (tok.length > 0) textParts.push(tok);
      continue;
    }
    const key = tok.slice(0, eq).toLowerCase();
    const rawValue = tok.slice(eq + 1);

    if (!VALUE_KEYS.has(key) || rawValue.length === 0) {
      textParts.push(tok);
      continue;
    }

    const values = rawValue.split(",").map((v) => v.trim()).filter(Boolean);
    if (values.length === 0) continue;

    if (key === "assignee") {
      // Single-valued; last write wins. We keep the raw value here — `me`
      // resolution happens at the consumer with the auth store in scope.
      result.assignee = values[0];
    } else if (key === "project") {
      // Project keys are conventionally uppercase. Normalize so users can
      // type lowercase and still get a match.
      result.project.push(...values.map((v) => v.toUpperCase()));
    }
  }

  result.text = textParts.length > 0 ? textParts.join(" ") : undefined;
  return result;
}

// Round-trip a ParsedQuery back to a query string. Used when the user toggles
// off a parsed chip — we mutate the structured form, then write a refreshed
// string back into the input. Quoted text is re-quoted only when it contains
// spaces, to keep the rendered string compact.
export function stringifySearchQuery(q: ParsedQuery): string {
  const parts: string[] = [];
  if (q.text) parts.push(/\s/.test(q.text) ? `"${q.text.replace(/"/g, '\\"')}"` : q.text);
  if (q.project.length) parts.push(`project=${q.project.join(",")}`);
  if (q.assignee) parts.push(`assignee=${q.assignee}`);
  return parts.join(" ");
}
