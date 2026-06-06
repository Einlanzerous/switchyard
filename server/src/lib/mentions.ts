// @mention detection + notification-write helpers.
//
// Centralized so comment creation, comment edits, ticket description
// creation, and ticket description edits all share the same regex,
// snippet logic, and dedup behavior.
//
// Dedup is in application code (a SELECT-then-INSERT inside the caller's
// transaction) rather than via a unique constraint with NULLS NOT DISTINCT
// — keeps us off the PG-15-specific syntax and makes the intent obvious in
// the call site.

import { and, eq, inArray, isNull, type SQL } from "drizzle-orm";
import * as schema from "../../drizzle/schema.js";
import type { db as defaultDb } from "../db.js";

type Tx = typeof defaultDb;
type UserRow = typeof schema.users.$inferSelect;
type NotificationKind = "mention";
type MentionSource = "comment" | "description";

// Pull every `@something` token out of arbitrary markdown text. We don't
// resolve to users yet — the caller decides which names actually belong
// to known users. Names are returned lowercased and de-duplicated to
// preserve insertion order so snippet computation stays stable.
const MENTION_RE = /(?:^|[^\w])@(\w+)/gi;

function extractMentionedNames(text: string | null | undefined): string[] {
  if (!text) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of text.matchAll(MENTION_RE)) {
    const name = (m[1] ?? "").toLowerCase();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

// Look up the lowercase names against `users`. Soft-deleted users are
// skipped so a tombstoned account doesn't keep generating notifications.
async function resolveMentionedUsers(
  tx: Tx,
  names: string[]
): Promise<UserRow[]> {
  if (names.length === 0) return [];
  // Postgres ILIKE would work, but we want exact case-insensitive equality
  // on the lower-cased name. Pull all candidates and match in JS to avoid
  // reading user names as patterns.
  const rows = await tx
    .select()
    .from(schema.users)
    .where(isNull(schema.users.deleted_at));
  const want = new Set(names);
  return rows.filter((u) => want.has(u.name.toLowerCase()));
}

// Build a ~120-char snippet centered on the first occurrence of @<name> in
// the source text. Used as a preview in the notifications dropdown so the
// recipient can decide whether to dive in.
function snippetAround(text: string, name: string): string {
  const re = new RegExp(`(?:^|[^\\w])@${escapeRegex(name)}(?:$|[^\\w])`, "i");
  const m = re.exec(text);
  if (!m) return text.slice(0, 120);
  const at = m.index;
  const start = Math.max(0, at - 60);
  const end = Math.min(text.length, at + (m[0]?.length ?? 0) + 60);
  let s = text.slice(start, end).replace(/\s+/g, " ").trim();
  if (start > 0) s = "…" + s;
  if (end < text.length) s = s + "…";
  return s;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Write notifications for a freshly-detected set of mentions. Idempotent
// per (user_id, kind, ticket_id, comment_id) — re-runs (e.g. after a
// comment edit) won't double-notify previously-mentioned users. The
// `ticket_id` and `comment_id` together identify the source row; both can
// be null in extreme cases (description-mention with no ticket — never
// happens today, but defensive).
async function writeMentionNotifications(
  tx: Tx,
  opts: {
    recipients: UserRow[];
    actor: UserRow | null;
    ticket_id: string | null;
    comment_id: string | null;
    text: string;
    source: MentionSource;
  }
): Promise<void> {
  if (opts.recipients.length === 0) return;

  // Pull existing notifications matching the (user, ticket, comment) triple
  // to skip dupes. One query, then filter in memory.
  const userIds = opts.recipients.map((u) => u.id);
  const where: SQL[] = [
    eq(schema.notifications.kind, "mention"),
    inArray(schema.notifications.user_id, userIds),
  ];
  // For description-source: comment_id IS NULL. For comment-source: comment_id = X.
  // ticket_id behaves the same way.
  if (opts.ticket_id) where.push(eq(schema.notifications.ticket_id, opts.ticket_id));
  else where.push(isNull(schema.notifications.ticket_id));
  if (opts.comment_id) where.push(eq(schema.notifications.comment_id, opts.comment_id));
  else where.push(isNull(schema.notifications.comment_id));

  const existing = await tx
    .select({ user_id: schema.notifications.user_id })
    .from(schema.notifications)
    .where(and(...where));
  const seen = new Set(existing.map((r) => r.user_id));

  const fresh = opts.recipients.filter((u) => !seen.has(u.id));
  if (fresh.length === 0) return;

  const actorId = opts.actor?.id ?? null;
  const actorRef = opts.actor
    ? {
        id: opts.actor.id,
        name: opts.actor.name,
        icon: opts.actor.icon,
        type: opts.actor.type,
      }
    : null;

  await tx.insert(schema.notifications).values(
    fresh.map((u) => ({
      user_id: u.id,
      kind: "mention" as NotificationKind,
      actor_id: actorId,
      ticket_id: opts.ticket_id,
      comment_id: opts.comment_id,
      payload: {
        actor: actorRef,
        source: opts.source,
        snippet: snippetAround(opts.text, u.name),
      },
    }))
  );
}

// Convenience wrapper for the common "scan text → write" flow used by the
// CREATE handlers. Returns the resolved recipients in case the caller wants
// to surface the count.
export async function detectAndNotify(
  tx: Tx,
  args: {
    text: string;
    actor: UserRow | null;
    ticket_id: string | null;
    comment_id: string | null;
    source: MentionSource;
  }
): Promise<UserRow[]> {
  const names = extractMentionedNames(args.text);
  if (names.length === 0) return [];
  const recipients = await resolveMentionedUsers(tx, names);
  if (recipients.length === 0) return [];
  await writeMentionNotifications(tx, {
    recipients,
    actor: args.actor,
    ticket_id: args.ticket_id,
    comment_id: args.comment_id,
    text: args.text,
    source: args.source,
  });
  return recipients;
}

// Edit-aware variant: notify only users that appear in the new text but
// did NOT appear in the old text. Re-edits to the same body don't re-fire.
export async function detectAndNotifyOnEdit(
  tx: Tx,
  args: {
    oldText: string | null;
    newText: string;
    actor: UserRow | null;
    ticket_id: string | null;
    comment_id: string | null;
    source: MentionSource;
  }
): Promise<UserRow[]> {
  const oldNames = new Set(extractMentionedNames(args.oldText));
  const newNames = extractMentionedNames(args.newText).filter((n) => !oldNames.has(n));
  if (newNames.length === 0) return [];
  const recipients = await resolveMentionedUsers(tx, newNames);
  if (recipients.length === 0) return [];
  await writeMentionNotifications(tx, {
    recipients,
    actor: args.actor,
    ticket_id: args.ticket_id,
    comment_id: args.comment_id,
    text: args.newText,
    source: args.source,
  });
  return recipients;
}
