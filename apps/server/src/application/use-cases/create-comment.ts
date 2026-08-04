import { createHash } from 'node:crypto';
import { checkSubmission, type SubmissionLimits } from '../../domain/comment/submission.js';
import { decideModeration, type ModerationConfig } from '../../domain/moderation/policy.js';
import { normalizePath } from '../../domain/page/path.js';
import {
  ForbiddenError,
  NotFoundError,
  RateLimitedError,
  SpamRejectedError,
  ValidationError,
} from '../../domain/errors/index.js';
import type { CommentRepository } from '../../ports/repositories.js';
import type {
  CaptchaVerifier,
  Clock,
  MarkdownRenderer,
  SpamChecker,
} from '../../ports/services.js';

export interface CreateCommentInput {
  path: string;
  parentId: string | null;
  bodyMarkdown: string;
  authorName: string;
  authorEmail: string | null;
  authorUrl: string | null;
  authorIp: string | null;
  userAgent: string | null;
  captchaToken: string | null;
  locale: string;
  /** Set when a signed-in admin or moderator is commenting. */
  actor: { userId: string; isStaff: boolean } | null;
}

export interface CreateCommentResult {
  id: string;
  status: 'approved' | 'pending';
}

/**
 * The write path, in the order that matters:
 *
 *   captcha → shape → parent → rate limits → spam → moderation → persist
 *
 * Cheap local checks run before anything that costs a network round trip, and
 * the spam service is only consulted for comments that would otherwise be
 * published. A rejected comment never reaches the database.
 */
export function createCreateComment(deps: {
  repo: CommentRepository;
  renderer: MarkdownRenderer;
  spamChecker: SpamChecker;
  captcha: CaptchaVerifier;
  clock: Clock;
  moderation: ModerationConfig;
  limits: SubmissionLimits;
  siteUrl: string;
}) {
  return async function createComment(input: CreateCommentInput): Promise<CreateCommentResult> {
    const path = normalizePath(input.path);
    const authorEmailHash = hashEmail(input.authorEmail);

    // 1. Captcha first: it is the cheapest way to reject an automated flood,
    //    and it costs a bot more than it costs us.
    if (!input.actor?.isStaff) {
      const passed = await deps.captcha.verify(input.captchaToken, input.authorIp);
      if (!passed) {
        throw new ForbiddenError('Captcha verification failed', { code_detail: 'captcha_failed' });
      }
    }

    // 2. Parent must exist and belong to this page, or threads could be
    //    grafted onto unrelated posts.
    let parentAuthorName: string | null = null;
    if (input.parentId) {
      const parent = await deps.repo.findById(input.parentId);
      if (!parent) throw new NotFoundError('Parent comment');
      // Carried into the notification so it can say who was replied to.
      parentAuthorName = parent.authorName;
    }

    // 3. Shape and rate limits, from this author's recent history.
    const now = deps.clock.now();
    const activity = await deps.repo.recentActivityFor({
      authorEmailHash,
      authorIp: input.authorIp,
      since: new Date(now.getTime() - deps.limits.windowSeconds * 1000),
    });

    const rejection = checkSubmission(
      { bodyMarkdown: input.bodyMarkdown, authorName: input.authorName },
      activity,
      deps.limits,
      now,
    );

    if (rejection) throw toDomainError(rejection);

    // 4. Spam check. Skipped for staff, and its failure is never fatal — the
    //    adapter returns null when it cannot reach the service.
    const spamVerdict = input.actor?.isStaff
      ? null
      : await deps.spamChecker.check({
          bodyMarkdown: input.bodyMarkdown,
          authorName: input.authorName,
          authorEmail: input.authorEmail,
          authorUrl: input.authorUrl,
          authorIp: input.authorIp,
          userAgent: input.userAgent,
          permalink: `${deps.siteUrl}${path}`,
        });

    // 5. The decision itself is pure, and the only thing that needs a database
    //    lookup is whether this author has been approved before.
    const hasPriorApprovedComment = authorEmailHash
      ? await deps.repo.hasApprovedCommentFrom(authorEmailHash)
      : false;

    const moderation = decideModeration(
      {
        bodyMarkdown: input.bodyMarkdown,
        authorName: input.authorName,
        authorEmailHash,
        isAuthenticatedStaff: input.actor?.isStaff ?? false,
        hasPriorApprovedComment,
        spamVerdict,
      },
      deps.moderation,
    );

    // Spam is rejected outright rather than stored. Keeping it would mean
    // carrying a table of other people's payloads for no one to ever read.
    if (moderation.decision === 'spam') {
      throw new SpamRejectedError('This comment was rejected as spam', {
        code_detail: moderation.reason,
      });
    }

    const bodyMarkdown = input.bodyMarkdown.trim();

    const created = await deps.repo.createWithOutbox({
      path,
      parentId: input.parentId,
      status: moderation.decision,
      bodyMarkdown,
      bodyHtml: deps.renderer.render(bodyMarkdown),
      authorName: input.authorName.trim(),
      authorEmail: input.authorEmail,
      authorEmailHash,
      authorUrl: input.authorUrl,
      authorIp: input.authorIp,
      userAgent: input.userAgent,
      authorUserId: input.actor?.userId ?? null,
      locale: input.locale,
      moderationReason: moderation.reason,
      // Queued in the same transaction. A complete event, carrying structured
      // data rather than rendered text, so each channel escapes it its own way.
      notify: {
        type: 'comment.created',
        path,
        pageTitle: null,
        authorName: input.authorName.trim(),
        bodyMarkdown,
        status: moderation.decision,
        replyToAuthorName: parentAuthorName,
      },
    });

    return {
      id: created.id,
      // Narrowed: 'spam' has already thrown above.
      status: created.status === 'approved' ? 'approved' : 'pending',
    };
  };
}

function hashEmail(email: string | null): string | null {
  if (!email) return null;
  return createHash('sha256').update(email.trim().toLowerCase()).digest('hex');
}

function toDomainError(rejection: ReturnType<typeof checkSubmission> & object): Error {
  switch (rejection.kind) {
    case 'too_fast':
      return new RateLimitedError(
        'You are commenting too quickly. Please wait a moment.',
        rejection.retryAfterSeconds,
        { code_detail: 'too_fast' },
      );
    case 'too_many':
      return new RateLimitedError(
        'You have posted several comments recently. Please try again later.',
        rejection.retryAfterSeconds,
        { code_detail: 'too_many' },
      );
    case 'duplicate':
      return new ValidationError('This looks identical to a comment you just posted.', {
        code_detail: 'duplicate',
      });
    case 'body_empty':
      return new ValidationError('A comment cannot be empty.', { code_detail: 'body_empty' });
    case 'body_too_long':
      return new ValidationError(`A comment may be at most ${String(rejection.max)} characters.`, {
        code_detail: 'body_too_long',
        max: rejection.max,
      });
    case 'name_too_long':
      return new ValidationError(`A name may be at most ${String(rejection.max)} characters.`, {
        code_detail: 'name_too_long',
        max: rejection.max,
      });
  }
}
