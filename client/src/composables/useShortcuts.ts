// Global keyboard shortcuts for the app shell.
//
// Single-key shortcuts (`c`, `?`) and two-key sequences (`g t`, `g b`, …) are
// both supported. Sequences expire after 1s of inactivity. Shortcuts skip
// when the user is typing in an input/textarea/contentEditable so we don't
// hijack their composition.

import { onMounted, onBeforeUnmount } from "vue";

type Handlers = Record<string, () => void>;

const SEQUENCE_TIMEOUT_MS = 1_000;

function isTypingTarget(t: EventTarget | null): boolean {
  if (!t || !(t instanceof HTMLElement)) return false;
  if (t.isContentEditable) return true;
  const tag = t.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

export function useShortcuts(handlers: Handlers) {
  let pendingPrefix: string | null = null;
  let pendingTimer: ReturnType<typeof setTimeout> | null = null;

  function clearPending() {
    pendingPrefix = null;
    if (pendingTimer) {
      clearTimeout(pendingTimer);
      pendingTimer = null;
    }
  }

  function onKeydown(e: KeyboardEvent) {
    // Skip when typing. Ctrl+K is intentionally allowed everywhere — it's
    // the universal "open command palette" gesture and users expect it to
    // work even mid-type.
    const typing = isTypingTarget(e.target);
    const key = e.key.toLowerCase();

    if (e.ctrlKey || e.metaKey) {
      const combo = `${e.ctrlKey ? "ctrl" : "meta"}+${key}`;
      const fn = handlers[combo] ?? handlers[`mod+${key}`];
      if (fn) {
        e.preventDefault();
        fn();
      }
      return;
    }

    if (typing) return;

    // Resolve a pending sequence first.
    if (pendingPrefix) {
      const seq = `${pendingPrefix} ${key}`;
      clearPending();
      const fn = handlers[seq];
      if (fn) {
        e.preventDefault();
        fn();
      }
      return;
    }

    // Start a sequence?
    if (key === "g" && Object.keys(handlers).some((h) => h.startsWith("g "))) {
      pendingPrefix = "g";
      pendingTimer = setTimeout(clearPending, SEQUENCE_TIMEOUT_MS);
      return;
    }

    // Single-key handler.
    const fn = handlers[key] ?? (e.shiftKey && key === "/" ? handlers["?"] : undefined);
    if (fn) {
      e.preventDefault();
      fn();
    }
  }

  onMounted(() => window.addEventListener("keydown", onKeydown));
  onBeforeUnmount(() => {
    window.removeEventListener("keydown", onKeydown);
    clearPending();
  });
}
