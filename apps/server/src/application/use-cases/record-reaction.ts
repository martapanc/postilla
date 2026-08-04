import { createHmac } from 'node:crypto';
import { reactionDedupeKey } from '../../domain/notifications/coalesce.js';
import { normalizePath } from '../../domain/page/path.js';
import { NotFoundError } from '../../domain/errors/index.js';
import type { ReactionRepository } from '../../ports/repositories.js';
import type { Clock } from '../../ports/services.js';

export interface RecordReactionInput {
  path: string;
  kindKey: string;
  /** Toggling off an existing reaction. */
  remove: boolean;
  visitorIp: string | null;
  userAgent: string | null;
}

export interface RecordReactionResult {
  kindKey: string;
  kindTotal: number;
  pageTotal: number;
  /** Whether this visitor's reaction is now recorded. */
  active: boolean;
}

/**
 * Records or removes one reaction.
 *
 * The old system stored reactions as bare counters, so the same visitor could
 * inflate a count from another browser and there was no way to take one back.
 * Here each reaction is a row keyed by a visitor hash, which makes it
 * idempotent and toggleable.
 */
export function createRecordReaction(deps: {
  repo: ReactionRepository;
  clock: Clock;
  secretKey: string;
  coalesceWindowSeconds: number;
}) {
  return async function recordReaction(input: RecordReactionInput): Promise<RecordReactionResult> {
    const path = normalizePath(input.path);
    const now = deps.clock.now();

    const kind = await deps.repo.findKind(input.kindKey);
    if (!kind) throw new NotFoundError('Reaction kind', { kindKey: input.kindKey });

    const pageId = await deps.repo.ensurePage(path);

    const visitorHash = hashVisitor({
      ip: input.visitorIp,
      userAgent: input.userAgent,
      secretKey: deps.secretKey,
      now,
    });

    const { added, kindTotal, pageTotal } = input.remove
      ? await deps.repo.removeReaction({ pageId, kindKey: kind.key, visitorHash })
      : await deps.repo.addReaction({ pageId, kindKey: kind.key, visitorHash });

    // Only a new reaction is worth announcing; a toggle-off is not news, and
    // re-clicking an existing one adds nothing.
    if (added) {
      await deps.repo.queueReactionNotification({
        dedupeKey: reactionDedupeKey({
          pageId,
          kindKey: kind.key,
          now,
          windowSeconds: deps.coalesceWindowSeconds,
        }),
        event: {
          type: 'reaction.added',
          path,
          pageTitle: null,
          kindKey: kind.key,
          emoji: kind.emoji,
          // All three figures travel together so the template chooses, rather
          // than the call site guessing — the inconsistency this replaces.
          kindTotal,
          pageTotal,
          delta: 1,
        },
      });
    }

    return { kindKey: kind.key, kindTotal, pageTotal, active: input.remove ? false : true };
  };
}

/**
 * A pseudonymous, rotating identifier for one visitor.
 *
 * Keyed HMAC rather than a plain hash so the value cannot be reversed by
 * guessing IPs, and salted with the date so it stops being linkable after a
 * day. Enough to stop casual double-counting; deliberately not an identity.
 */
function hashVisitor(input: {
  ip: string | null;
  userAgent: string | null;
  secretKey: string;
  now: Date;
}): string {
  const day = input.now.toISOString().slice(0, 10);
  return createHmac('sha256', input.secretKey)
    .update(`${input.ip ?? 'unknown'}|${input.userAgent ?? 'unknown'}|${day}`)
    .digest('hex');
}
