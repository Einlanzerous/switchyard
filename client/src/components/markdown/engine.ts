import MarkdownIt from "markdown-it";
import { alert } from "@mdit/plugin-alert";
import { tasklist } from "@mdit/plugin-tasklist";

// One MarkdownIt instance is reused across all renders — and shared with
// taskToggle.ts so checkbox→source mapping uses the exact same parser that
// produced the rendered checkboxes. Configured for the agentic ticket
// workflow: GFM tables on, autolinks on, html OFF (we never trust raw HTML
// in ticket bodies), single-newline → <br> for paragraph-light agent
// output, and external links default to opening in a new tab.
export const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
  typographer: false,
});

// GFM alerts (`> [!WARNING]` …) — the dialect agents already emit; degrades
// to a plain blockquote in renderers that don't know it. Task-list checkboxes
// render disabled; Markdown.vue re-enables them per-surface when the caller
// opts into interactive toggling.
md.use(alert);
md.use(tasklist);

const defaultLinkOpen = md.renderer.rules.link_open ?? function (tokens, idx, options, _env, self) {
  return self.renderToken(tokens, idx, options);
};
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  const token = tokens[idx];
  if (token) {
    const href = token.attrGet("href");
    if (href && /^https?:\/\//.test(href)) {
      token.attrSet("target", "_blank");
      token.attrSet("rel", "noopener noreferrer");
    }
  }
  return defaultLinkOpen(tokens, idx, options, env, self);
};
