import type { CommentThread, ListCommentsResponse } from '@postilla/contract';
import { buildThreads } from '../../domain/comment/thread.js';
import { normalizePath } from '../../domain/page/path.js';
import type { CommentRecord, CommentRepository } from '../../ports/repositories.js';

/**
 * Reads one page of a comment thread.
 *
 * Orchestration only: path normalization and thread assembly are domain rules,
 * fetching is the repository's job, and this decides the order in which they
 * happen and what the caller gets back.
 */
export function createListComments(repo: CommentRepository) {
  return async function listComments(input: {
    path: string;
    sort: 'latest' | 'oldest' | 'hottest';
    page: number;
    pageSize: number;
  }): Promise<ListCommentsResponse> {
    const path = normalizePath(input.path);

    const { comments, totalRoots, totalComments } = await repo.listApprovedThreads({
      path,
      sort: input.sort,
      page: input.page,
      pageSize: input.pageSize,
    });

    const nameById = new Map(comments.map((c) => [c.id, c.authorName]));

    const threads: CommentThread[] = buildThreads(comments, input.sort, (c) => c.likeCount).map(
      (thread) => ({
        root: toPublic(thread.root, nameById),
        replies: thread.replies.map((reply) => toPublic(reply, nameById)),
      }),
    );

    return {
      threads,
      pagination: {
        page: input.page,
        pageSize: input.pageSize,
        total: totalRoots,
        totalPages: Math.max(1, Math.ceil(totalRoots / input.pageSize)),
      },
      totalComments,
    };
  };
}

/**
 * Narrows a stored comment to what the public contract exposes. Email, email
 * hash, IP and user agent are dropped here and again by the response
 * serializer — two independent gates, because leaking them is unrecoverable.
 */
function toPublic(comment: CommentRecord, nameById: Map<string, string>): CommentThread['root'] {
  // Only set when replying to another reply, so the UI can render "@someone"
  // without implying a reply to the thread's author.
  const replyToName =
    comment.parentId && comment.parentId !== comment.rootId
      ? (nameById.get(comment.parentId) ?? null)
      : null;

  return {
    id: comment.id,
    parentId: comment.parentId,
    authorName: comment.authorName,
    authorUrl: comment.authorUrl,
    authorAvatarUrl: comment.authorAvatarUrl,
    authorIsAdmin: comment.authorIsAdmin,
    bodyHtml: comment.bodyHtml,
    createdAt: comment.createdAt.toISOString(),
    isSticky: comment.isSticky,
    likeCount: comment.likeCount,
    replyToName,
  };
}
