/**
 * A reaction is one click. Someone idly tapping 🔥 forty times would otherwise
 * produce forty Telegram messages.
 *
 * The dedupe key buckets events by page, kind, and a time window. A partial
 * unique index on undelivered outbox rows turns a burst inside one window into
 * a single row, and because the payload is overwritten on conflict the message
 * that eventually goes out carries the final counts rather than the first.
 */
export function reactionDedupeKey(input: {
  pageId: string;
  kindKey: string;
  now: Date;
  windowSeconds: number;
}): string {
  const bucket = Math.floor(input.now.getTime() / 1000 / input.windowSeconds);
  return `reaction:${input.pageId}:${input.kindKey}:${String(bucket)}`;
}
