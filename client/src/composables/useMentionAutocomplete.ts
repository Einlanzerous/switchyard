// @mention autocomplete for any plain <textarea> backed by a v-model ref.
//
// Detects when the caret is immediately after an `@<query>` token (no
// whitespace between `@` and caret), surfaces a filtered user list, and on
// select replaces `@<query>` with `@<name> ` (trailing space) at the
// matching offset.
//
// Position is anchored below the textarea — pixel-perfect caret tracking
// in a textarea requires a mirror-div trick that's not worth the
// complexity in v1. Linear-style cursor-following can be a 3.4 polish.
//
// Keyboard contract (only when popover is open):
//   ArrowDown / ArrowUp  — move selection
//   Enter / Tab          — insert selected user
//   Escape               — dismiss
// onKeydown returns true when it handled the key so the consumer's own
// keydown handler (Ctrl+Enter, Esc, etc.) can defer to it.

import { computed, nextTick, ref, type Ref } from "vue";
import type { UserRef } from "@switchyard/shared";

const MAX_RESULTS = 8;

export type MentionAutocompleteApi = {
  open: Ref<boolean>;
  query: Ref<string>;
  filtered: Ref<UserRef[]>;
  selectedIndex: Ref<number>;
  onInput: () => void;
  onKeydown: (e: KeyboardEvent) => boolean;
  onBlur: () => void;
  pick: (user: UserRef) => void;
  close: () => void;
};

export function useMentionAutocomplete(args: {
  textareaRef: Ref<HTMLTextAreaElement | null>;
  bodyRef: Ref<string>;
  users: Ref<UserRef[]>;
}): MentionAutocompleteApi {
  const open = ref(false);
  const query = ref("");
  const selectedIndex = ref(0);
  // Offset of the `@` character we're attaching to. Set when the trigger
  // fires; used to know what range to replace on select.
  const anchorAt = ref<number | null>(null);

  const filtered = computed(() => {
    if (!open.value) return [];
    const q = query.value.toLowerCase();
    const all = args.users.value ?? [];
    if (q.length === 0) return all.slice(0, MAX_RESULTS);
    return all
      .filter((u) => u.name.toLowerCase().includes(q))
      .slice(0, MAX_RESULTS);
  });

  function close() {
    open.value = false;
    query.value = "";
    selectedIndex.value = 0;
    anchorAt.value = null;
  }

  // Inspect the text up to the current caret. If it ends in `@<word>`
  // without whitespace breaking the run, we're in mention-trigger mode.
  // The `@` must also be at the start of input or preceded by whitespace
  // so that `email@host.com`-style addresses don't trigger.
  function detect() {
    const ta = args.textareaRef.value;
    if (!ta) return close();

    const caret = ta.selectionStart ?? 0;
    const before = args.bodyRef.value.slice(0, caret);
    const lastAt = before.lastIndexOf("@");
    if (lastAt === -1) return close();

    // Whitespace inside the candidate query → not a mention anymore.
    const candidate = before.slice(lastAt + 1);
    if (/\s/.test(candidate)) return close();

    // Guard: `@` must be at start or after whitespace.
    if (lastAt > 0 && !/\s/.test(before[lastAt - 1] ?? "")) return close();

    open.value = true;
    query.value = candidate;
    anchorAt.value = lastAt;
    // Reset highlight to the top whenever the query changes.
    selectedIndex.value = 0;
  }

  function onInput() {
    detect();
  }

  function onBlur() {
    // Defer so a click on a list item still has a chance to fire its
    // mousedown handler before the popover unmounts.
    setTimeout(close, 100);
  }

  function pick(user: UserRef) {
    const ta = args.textareaRef.value;
    if (!ta || anchorAt.value === null) return;
    const caret = ta.selectionStart ?? 0;
    const text = args.bodyRef.value;
    const insert = `@${user.name} `;
    const next = text.slice(0, anchorAt.value) + insert + text.slice(caret);
    args.bodyRef.value = next;
    const newCaret = anchorAt.value + insert.length;
    close();
    void nextTick(() => {
      if (ta) {
        ta.focus();
        ta.setSelectionRange(newCaret, newCaret);
      }
    });
  }

  function onKeydown(e: KeyboardEvent): boolean {
    if (!open.value || filtered.value.length === 0) return false;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      selectedIndex.value = (selectedIndex.value + 1) % filtered.value.length;
      return true;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      selectedIndex.value = selectedIndex.value === 0
        ? filtered.value.length - 1
        : selectedIndex.value - 1;
      return true;
    }
    if (e.key === "Enter" || e.key === "Tab") {
      // Don't intercept Ctrl+Enter — that's the parent's submit shortcut.
      if (e.ctrlKey || e.metaKey) return false;
      e.preventDefault();
      const user = filtered.value[selectedIndex.value];
      if (user) pick(user);
      return true;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      close();
      return true;
    }
    return false;
  }

  return { open, query, filtered, selectedIndex, onInput, onKeydown, onBlur, pick, close };
}
