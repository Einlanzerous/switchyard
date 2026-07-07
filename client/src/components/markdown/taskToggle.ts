import { md } from "./engine";

// Source-side task-list toggling for interactive checkboxes (SWY-159).
//
// The clicked checkbox is identified by its ordinal among rendered
// checkboxes; this module finds the same ordinal task item in the SOURCE
// markdown by parsing it with the shared md instance — the tasklist plugin
// tags each recognized item's list_item_open token with class
// `task-list-item` and tokens carry source line maps, so recognition here
// can never disagree with what was rendered (a `- [ ]` inside a code fence,
// for example, is invisible to both).

interface TaskItem {
  line: number;
  checked: boolean;
  /** Inline markdown of the item's first paragraph, marker stripped. */
  rest: string;
}

function collectTaskItems(source: string): TaskItem[] {
  const tokens = md.parse(source, {});
  const items: TaskItem[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (!t || t.type !== "list_item_open") continue;
    if (!(t.attrGet("class") ?? "").split(" ").includes("task-list-item")) continue;
    // Plugin-recognized shape is list_item_open → paragraph_open → inline.
    const inline = tokens[i + 2];
    if (!t.map || inline?.type !== "inline") continue;
    // inline.content still holds the raw `[x] rest…` (the plugin only
    // rewrites the token's children, not its content).
    items.push({
      line: t.map[0],
      checked: /^\[[xX]\]/.test(inline.content),
      rest: inline.content.slice(4),
    });
  }
  return items;
}

// Render an item's inline markdown to plain text for comparison with the
// clicked label's textContent. A <template> keeps the parse inert (no
// resource loads). Both sides are whitespace-collapsed before comparing.
function inlineToText(src: string): string {
  const tpl = document.createElement("template");
  tpl.innerHTML = md.renderInline(src);
  return tpl.content.textContent ?? "";
}

const collapse = (s: string) => s.replace(/\s+/g, " ").trim();

// Matches the task marker on a source line: optional blockquote (`> `,
// covers checklists inside GFM alerts) and list-indent prefix, then a
// bullet or ordered marker, then `[ ]`/`[x]`. Capture groups preserve
// everything except the state character so the rewrite churns nothing else.
const MARKER = /^([>\s]*(?:[-+*]|\d+[.)])\s+\[)[ xX\u00a0](\])/;

/**
 * Toggle the `index`-th task checkbox in `source` to `checked`, provided the
 * item's rendered text still matches `expectedText` (the label the user
 * actually clicked). Returns the rewritten markdown, `source` unchanged when
 * the item is already in the desired state (double-click / echo), or `null`
 * on any mismatch — caller should treat that as a concurrent-edit conflict.
 */
export function toggleTaskInMarkdown(
  source: string,
  index: number,
  checked: boolean,
  expectedText: string,
): string | null {
  // markdown-it normalizes newlines before assigning token line maps.
  const normalized = source.replace(/\r\n?/g, "\n");
  const item = collectTaskItems(normalized)[index];
  if (!item) return null;
  if (collapse(inlineToText(item.rest)) !== collapse(expectedText)) return null;
  if (item.checked === checked) return normalized;
  const lines = normalized.split("\n");
  const line = lines[item.line] ?? "";
  if (!MARKER.test(line)) return null;
  lines[item.line] = line.replace(MARKER, `$1${checked ? "x" : " "}$2`);
  return lines.join("\n");
}
