/**
 * Notification events carry structured data — never pre-rendered HTML.
 *
 * That is the fix for a specific bug in the system this replaces: its
 * notifications were built from already-rendered comment HTML, so every
 * template had to decode entities and strip tags back out again with regexes.
 * Building from the markdown source instead means each channel escapes once,
 * for its own format, and the hack disappears.
 */

export interface CommentCreatedEvent {
  type: 'comment.created';
  commentId: string;
  path: string;
  pageTitle: string | null;
  authorName: string;
  bodyMarkdown: string;
  status: 'approved' | 'pending';
  /** Set when this comment is a reply, for "X replied to you". */
  replyToAuthorName: string | null;
}

export interface ReactionAddedEvent {
  type: 'reaction.added';
  path: string;
  pageTitle: string | null;
  kindKey: string;
  emoji: string;
  /**
   * Three separate figures, deliberately.
   *
   * The fork this replaces was inconsistent here: one call site reported the
   * count for the specific reaction, the other reported the sum across all
   * reaction types (and hardcoded 0..4 while the schema had 0..8). So the
   * first 🔥 said "Total: 1" and the second said "Total: 7" if six ❤️ came
   * before it. The message shows a kind-specific emoji, so per-kind was
   * clearly the intent — but rather than pick one and lose the other, the
   * event carries both and the template decides.
   */
  kindTotal: number;
  pageTotal: number;
  /** How many were added since the last notification for this coalescing window. */
  delta: number;
}

export type NotificationEvent = CommentCreatedEvent | ReactionAddedEvent;

/** What a channel can accept. Determines which escaper the renderer applies. */
export type MessageFormat = 'telegram-html' | 'discord-markdown' | 'email-html' | 'plain-text';

export interface RenderedMessage {
  /** Used by channels that have a subject line (email); ignored by the rest. */
  subject: string;
  body: string;
}
