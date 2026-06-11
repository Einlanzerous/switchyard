// Copy text to the clipboard with a fallback for non-secure contexts.
//
// `navigator.clipboard` is only defined in a secure context (HTTPS or
// localhost). switchyard is deployed over a tailnet on plain HTTP, where the
// async Clipboard API is `undefined` and any call throws — which is why the
// invite "Copy" button silently did nothing. We fall back to the legacy
// `document.execCommand("copy")` path (a hidden, selected <textarea>), which
// works on HTTP. Returns whether the copy succeeded so callers can toast.
export async function copyToClipboard(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall through to the execCommand path (e.g. permission denied).
    }
  }

  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    // Keep it out of view and unfocusable-scroll, but still selectable.
    ta.style.position = "fixed";
    ta.style.top = "-9999px";
    ta.style.opacity = "0";
    ta.setAttribute("readonly", "");
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
