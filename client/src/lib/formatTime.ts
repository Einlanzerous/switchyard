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
