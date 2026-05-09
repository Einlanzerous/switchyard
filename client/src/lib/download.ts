// Authenticated file downloads.
//
// Browsers don't include the Authorization header on plain link clicks, so
// `<a href>` against /v1/attachments/{id} returns 401. This helper does the
// fetch in JS, attaches the bearer token, then triggers a download via an
// object URL. Works for any size we'd realistically attach (binary files
// stream; the browser holds the blob in memory until release).

import { getStoredToken } from "./api";

export async function downloadAttachment(
  attachmentId: string,
  filename: string | null,
): Promise<void> {
  const token = getStoredToken();
  const res = await fetch(`/v1/attachments/${encodeURIComponent(attachmentId)}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) {
    let message = `download failed (${res.status})`;
    try {
      const body = (await res.json()) as { error?: { message?: string } };
      if (body?.error?.message) message = body.error.message;
    } catch { /* non-JSON body */ }
    throw new Error(message);
  }

  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement("a");
    a.href = url;
    a.download = filename ?? attachmentId;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    // Revoke async to give the browser a tick to start the download.
    setTimeout(() => URL.revokeObjectURL(url), 1_000);
  }
}
