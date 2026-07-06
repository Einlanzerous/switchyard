// Shared relative-time helpers. Same date-fns pattern that views like
// SettingsTokens and TicketRow already use, just centralized so widgets
// don't reimplement the try/catch each time.

import { formatDistanceToNow } from "date-fns";

export function formatRelativeTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return formatDistanceToNow(new Date(iso), { addSuffix: true });
  } catch {
    return "—";
  }
}

// Terse single-unit form ("2m", "3h", "4d", "2w") for dense dashboard rows
// where "about 3 hours ago" doesn't fit. Sub-minute rounds to "now".
export function formatCompactRelativeTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "—";
  const mins = Math.floor((Date.now() - then) / 60_000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 14) return `${days}d`;
  return `${Math.floor(days / 7)}w`;
}
