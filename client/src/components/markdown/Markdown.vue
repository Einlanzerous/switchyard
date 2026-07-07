<script setup lang="ts">
import { computed } from "vue";
import DOMPurify from "dompurify";
import { md } from "./engine";

const HEX_CODE = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g;

// Post-render DOM pass. Runs AFTER DOMPurify on already-sanitized markup
// and only inserts elements built via DOM APIs from regex-constrained
// matches, so it cannot introduce anything the sanitizer would have
// stripped. Two jobs:
//  - decorate hex color codes in table cells with an inline swatch chip
//  - when the caller opts into interactive task lists, re-enable the
//    checkboxes (the tasklist plugin emits them disabled) and drop the
//    label→input `for` association so only the box itself toggles — text
//    clicks would otherwise write to the description on a stray selection.
function postProcess(html: string, interactive: boolean): string {
  if (!interactive && !html.includes("<td")) return html;
  const tpl = document.createElement("template");
  tpl.innerHTML = html;
  if (interactive) {
    for (const box of tpl.content.querySelectorAll("input.task-list-item-checkbox")) {
      box.removeAttribute("disabled");
    }
    for (const label of tpl.content.querySelectorAll("label.task-list-item-label")) {
      label.removeAttribute("for");
    }
  }
  for (const td of tpl.content.querySelectorAll("td")) {
    const walker = document.createTreeWalker(td, NodeFilter.SHOW_TEXT);
    const textNodes: Text[] = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) textNodes.push(n as Text);
    for (const node of textNodes) {
      // Hex codes inside inline code or links keep their own treatment.
      if (node.parentElement?.closest("code, a")) continue;
      const text = node.nodeValue ?? "";
      const matches = [...text.matchAll(HEX_CODE)];
      if (matches.length === 0) continue;
      const frag = document.createDocumentFragment();
      let last = 0;
      for (const m of matches) {
        frag.append(text.slice(last, m.index));
        const chip = document.createElement("span");
        chip.className = "hexchip";
        const swatch = document.createElement("i");
        swatch.style.background = m[0];
        chip.append(swatch, m[0]);
        frag.append(chip);
        last = m.index + m[0].length;
      }
      frag.append(text.slice(last));
      node.replaceWith(frag);
    }
  }
  return tpl.innerHTML;
}

const props = defineProps<{
  body: string;
  /** Enable clickable task-list checkboxes. Caller persists via @toggle-task. */
  interactiveTasks?: boolean;
}>();

const emit = defineEmits<{
  toggleTask: [payload: { index: number; checked: boolean; text: string }];
}>();

const html = computed(() =>
  postProcess(DOMPurify.sanitize(md.render(props.body ?? "")), props.interactiveTasks ?? false),
);

// Click delegation over v-html content. The checkbox's ordinal among all
// rendered checkboxes identifies the task; taskToggle.ts re-finds it in the
// source. preventDefault keeps the DOM box on its rendered state — the
// visual flip arrives with the re-render after the PATCH round-trips.
function onClick(e: MouseEvent) {
  if (!props.interactiveTasks) return;
  const target = e.target;
  if (!(target instanceof HTMLInputElement) || !target.classList.contains("task-list-item-checkbox")) return;
  e.preventDefault();
  const root = e.currentTarget as HTMLElement;
  const boxes = Array.from(root.querySelectorAll("input.task-list-item-checkbox"));
  // Checkbox activation flips `checked` before the click event fires (and
  // reverts it on preventDefault), so `target.checked` here IS the state
  // the user asked for.
  emit("toggleTask", {
    index: boxes.indexOf(target),
    checked: target.checked,
    text: target.nextElementSibling?.textContent ?? target.closest("li")?.textContent ?? "",
  });
}
</script>

<template>
  <!-- prose-* utilities apply Tailwind's typography styles. The container is
       sized down with prose-sm and dark-mode flips with prose-invert. The
       md-body class carries the v4 overrides (callouts, tables, hexchips,
       task lists, inline code) defined below. -->
  <div
    class="md-body prose prose-sm dark:prose-invert max-w-none break-words
           prose-headings:font-semibold prose-headings:tracking-tight
           prose-pre:bg-muted prose-pre:text-foreground/90
           prose-a:text-primary"
    v-html="html"
    @click="onClick"
  />
</template>

<style>
/* v4 "Elevated" rich-body styles (SWY-156). Mock: design_handoff_switchyard_v4/
   ticket-drawer.html `.desc` — mock --accent-2/--accent-line map to the client's
   --signal-2/--signal-line. Namespaced under .md-body; the typography plugin's
   :where() selectors have lower specificity, so these win without !important. */

/* Inline code (block code keeps the prose-pre treatment). */
.md-body :not(pre) > code {
  font-family: var(--mono);
  font-size: 11.5px;
  font-weight: 400;
  background: var(--surface-4);
  border: 1px solid var(--line);
  border-radius: 4px;
  padding: 1px 5px;
  color: var(--signal-2);
}
.md-body code::before,
.md-body code::after {
  content: none;
}

/* Callouts (GFM alerts). One shell for every type; the icon carries the tone. */
.md-body .markdown-alert {
  position: relative;
  margin: 14px 0;
  padding: 13px 15px 13px 44px;
  border-radius: 9px;
  border: 1px solid var(--signal-line);
  background: linear-gradient(180deg, rgba(226, 98, 61, 0.08), var(--surface-2));
}
.md-body .markdown-alert::before {
  content: "";
  position: absolute;
  left: 15px;
  top: 14px;
  width: 18px;
  height: 18px;
  background-color: var(--signal-2);
  mask: var(--alert-icon) no-repeat center / contain;
  -webkit-mask: var(--alert-icon) no-repeat center / contain;
}
.md-body .markdown-alert-warning {
  --alert-icon: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M10.3 3.9L2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z'/%3E%3Cpath d='M12 9v4'/%3E%3Cpath d='M12 17h.01'/%3E%3C/svg%3E");
}
.md-body .markdown-alert-caution {
  --alert-icon: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M7.86 2h8.28L22 7.86v8.28L16.14 22H7.86L2 16.14V7.86z'/%3E%3Cpath d='M12 8v4'/%3E%3Cpath d='M12 16h.01'/%3E%3C/svg%3E");
}
.md-body .markdown-alert-important {
  --alert-icon: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z'/%3E%3Cpath d='M12 7v2'/%3E%3Cpath d='M12 13h.01'/%3E%3C/svg%3E");
}
.md-body .markdown-alert-important::before {
  background-color: var(--st-planning);
}
.md-body .markdown-alert-note {
  --alert-icon: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Ccircle cx='12' cy='12' r='10'/%3E%3Cpath d='M12 16v-4'/%3E%3Cpath d='M12 8h.01'/%3E%3C/svg%3E");
}
.md-body .markdown-alert-note::before {
  background-color: var(--st-progress);
}
.md-body .markdown-alert-tip {
  --alert-icon: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M15.09 14c.18-.98.65-1.74 1.41-2.5A4.65 4.65 0 0 0 18 8 6 6 0 0 0 6 8c0 1 .23 2.23 1.5 3.5.76.76 1.23 1.52 1.41 2.5'/%3E%3Cpath d='M9 18h6'/%3E%3Cpath d='M10 22h4'/%3E%3C/svg%3E");
}
.md-body .markdown-alert-tip::before {
  background-color: var(--st-closed);
}
.md-body .markdown-alert p {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.55;
  color: var(--text-2);
}
.md-body .markdown-alert p + p {
  margin-top: 3px;
}
.md-body .markdown-alert-title {
  font-size: 13.5px;
  font-weight: 700;
  color: var(--text);
}

/* Tables — mock `.dtable`: mono uppercase headers, emphasized first column. */
.md-body table {
  width: 100%;
  border-collapse: collapse;
  margin: 6px 0 14px;
  font-size: 12.5px;
}
.md-body th {
  text-align: left;
  font-family: var(--mono);
  font-size: 10px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--text-3);
  font-weight: 500;
  padding: 7px 10px;
  border-bottom: 1px solid var(--line);
}
.md-body td {
  padding: 8px 10px;
  border-bottom: 1px solid var(--line-soft);
  color: var(--text-2);
}
.md-body td:first-child {
  color: var(--text);
  font-weight: 500;
}

/* Hex swatch chips injected by decorateHexChips(). */
.md-body .hexchip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-family: var(--mono);
  font-size: 11px;
}
.md-body .hexchip i {
  width: 11px;
  height: 11px;
  border-radius: 3px;
  flex: none;
  font-style: normal;
}

/* Task lists — 16px checkboxes; checked = green check (never a red X). */
.md-body ul.task-list-container {
  list-style: none;
  padding-left: 2px;
  margin: 8px 0 14px;
}
.md-body ul.task-list-container ul.task-list-container {
  padding-left: 25px;
  margin: 7px 0 0;
}
.md-body li.task-list-item {
  display: flex;
  align-items: flex-start;
  gap: 9px;
  margin: 0 0 7px;
  padding-left: 0;
}
.md-body li.task-list-item > .task-list-item-label {
  min-width: 0;
}
.md-body input.task-list-item-checkbox {
  appearance: none;
  -webkit-appearance: none;
  width: 16px;
  height: 16px;
  border: 1.5px solid var(--line);
  border-radius: 4px;
  background: var(--surface-2);
  flex: none;
  margin: 2px 0 0;
}
.md-body input.task-list-item-checkbox:not([disabled]) {
  cursor: pointer;
}
.md-body input.task-list-item-checkbox:not([disabled]):hover {
  border-color: var(--text-3);
}
.md-body input.task-list-item-checkbox:checked {
  border-color: var(--st-closed);
  background: var(--st-closed-bg) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%2363b58c' stroke-width='3' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M20 6 9 17l-5-5'/%3E%3C/svg%3E") no-repeat center / 10px 10px;
}
</style>
