import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { comments, pages, reactionBaselines, reactions, users } from '../schema.js';
import { createCommentRepository } from './comment-repository.js';
import { createPageRepository } from './page-repository.js';
import { connectTestDatabase, type TestDatabase } from '../../../test-support/database.js';
import type { CommentRepository, PageRepository } from '../../../ports/repositories.js';

let harness: TestDatabase;
let commentRepo: CommentRepository;
let pageRepo: PageRepository;

beforeAll(() => {
  harness = connectTestDatabase();
  commentRepo = createCommentRepository(harness.db);
  pageRepo = createPageRepository(harness.db);
});

afterAll(async () => await harness.close());
beforeEach(async () => await harness.reset());

async function makePage(path: string, pageviews = 0): Promise<string> {
  const [row] = await harness.db
    .insert(pages)
    .values({ path, pageviews })
    .returning({ id: pages.id });
  return row!.id;
}

async function makeComment(over: {
  pageId: string;
  id?: string;
  parentId?: string | null;
  rootId?: string;
  status?: 'approved' | 'pending' | 'spam';
  authorName?: string;
  createdAt?: Date;
  isSticky?: boolean;
  likeCount?: number;
  authorUserId?: string;
}): Promise<string> {
  const id = over.id ?? randomUUID();
  await harness.db.insert(comments).values({
    id,
    pageId: over.pageId,
    parentId: over.parentId ?? null,
    rootId: over.rootId ?? id,
    status: over.status ?? 'approved',
    bodyMarkdown: 'body',
    bodyHtml: '<p>body</p>',
    authorName: over.authorName ?? 'Someone',
    authorEmail: 'someone@example.com',
    authorIp: '203.0.113.1',
    userAgent: 'Mozilla/5.0',
    createdAt: over.createdAt ?? new Date('2025-01-01T00:00:00Z'),
    isSticky: over.isSticky ?? false,
    likeCount: over.likeCount ?? 0,
    authorUserId: over.authorUserId ?? null,
  });
  return id;
}

describe('CommentRepository.listApprovedThreads', () => {
  it('returns an empty result for a page that does not exist', async () => {
    const result = await commentRepo.listApprovedThreads({
      path: '/nope',
      sort: 'latest',
      page: 1,
      pageSize: 10,
    });

    expect(result).toEqual({ comments: [], totalRoots: 0, totalComments: 0 });
  });

  it('excludes comments that are not approved', async () => {
    const pageId = await makePage('/p');
    await makeComment({ pageId, status: 'approved' });
    await makeComment({ pageId, status: 'pending' });
    await makeComment({ pageId, status: 'spam' });

    const result = await commentRepo.listApprovedThreads({
      path: '/p',
      sort: 'latest',
      page: 1,
      pageSize: 10,
    });

    expect(result.totalComments).toBe(1);
    expect(result.comments).toHaveLength(1);
  });

  it('counts roots and total comments separately', async () => {
    const pageId = await makePage('/p');
    const root = await makeComment({ pageId });
    await makeComment({ pageId, parentId: root, rootId: root });
    await makeComment({ pageId, parentId: root, rootId: root });

    const result = await commentRepo.listApprovedThreads({
      path: '/p',
      sort: 'latest',
      page: 1,
      pageSize: 10,
    });

    expect(result.totalRoots).toBe(1);
    expect(result.totalComments).toBe(3);
  });

  it('never splits a thread across a page boundary', async () => {
    // Two roots, page size 1: the returned root must arrive with all of its
    // replies, even though that is more rows than the page size.
    const pageId = await makePage('/p');
    const newer = await makeComment({ pageId, createdAt: new Date('2025-06-01T00:00:00Z') });
    await makeComment({
      pageId,
      parentId: newer,
      rootId: newer,
      createdAt: new Date('2025-06-02T00:00:00Z'),
    });
    await makeComment({
      pageId,
      parentId: newer,
      rootId: newer,
      createdAt: new Date('2025-06-03T00:00:00Z'),
    });
    await makeComment({ pageId, createdAt: new Date('2025-01-01T00:00:00Z') });

    const result = await commentRepo.listApprovedThreads({
      path: '/p',
      sort: 'latest',
      page: 1,
      pageSize: 1,
    });

    expect(result.totalRoots).toBe(2);
    expect(result.comments).toHaveLength(3);
    expect(result.comments.every((c) => c.rootId === newer)).toBe(true);
  });

  it('paginates over roots', async () => {
    const pageId = await makePage('/p');
    for (let i = 0; i < 5; i += 1) {
      await makeComment({ pageId, createdAt: new Date(`2025-01-0${i + 1}T00:00:00Z`) });
    }

    const second = await commentRepo.listApprovedThreads({
      path: '/p',
      sort: 'oldest',
      page: 2,
      pageSize: 2,
    });

    expect(second.totalRoots).toBe(5);
    expect(second.comments).toHaveLength(2);
  });

  it('puts sticky roots first regardless of sort', async () => {
    const pageId = await makePage('/p');
    await makeComment({ pageId, createdAt: new Date('2025-06-01T00:00:00Z') });
    const pinned = await makeComment({
      pageId,
      createdAt: new Date('2020-01-01T00:00:00Z'),
      isSticky: true,
    });

    for (const sort of ['latest', 'oldest', 'hottest'] as const) {
      const result = await commentRepo.listApprovedThreads({
        path: '/p',
        sort,
        page: 1,
        pageSize: 1,
      });
      expect(result.comments[0]?.id).toBe(pinned);
    }
  });

  it('marks admin authors so the UI can badge them', async () => {
    const pageId = await makePage('/p');
    const [admin] = await harness.db
      .insert(users)
      .values({
        email: 'admin@example.com',
        displayName: 'Admin',
        role: 'admin',
        passwordHash: 'x',
        passwordAlgo: 'phpass',
        avatarUrl: 'https://example.com/a.png',
      })
      .returning({ id: users.id });
    await makeComment({ pageId, authorUserId: admin!.id });
    await makeComment({ pageId });

    const result = await commentRepo.listApprovedThreads({
      path: '/p',
      sort: 'latest',
      page: 1,
      pageSize: 10,
    });

    expect(result.comments.filter((c) => c.authorIsAdmin)).toHaveLength(1);
    expect(result.comments.find((c) => c.authorIsAdmin)?.authorAvatarUrl).toBe(
      'https://example.com/a.png',
    );
  });
});

describe('CommentRepository.countApprovedByPaths', () => {
  it('returns zero for paths with no comments rather than omitting them', async () => {
    const pageId = await makePage('/has');
    await makePage('/empty');
    await makeComment({ pageId });

    const counts = await commentRepo.countApprovedByPaths(['/has', '/empty', '/unknown']);

    expect(counts.get('/has')).toBe(1);
    expect(counts.get('/empty')).toBe(0);
    expect(counts.get('/unknown')).toBe(0);
  });

  it('handles an empty request', async () => {
    expect(await commentRepo.countApprovedByPaths([])).toEqual(new Map());
  });
});

describe('PageRepository.getStats', () => {
  it('sums migrated baselines with live reaction events', async () => {
    // The property the whole reaction design rests on: LeanCloud totals have
    // no individual rows behind them, so both sources must be counted.
    const pageId = await makePage('/p', 100);
    await harness.db.insert(reactionBaselines).values({ pageId, kindKey: 'heart', count: 32 });
    await harness.db.insert(reactions).values([
      { pageId, kindKey: 'heart', visitorHash: 'v1' },
      { pageId, kindKey: 'heart', visitorHash: 'v2' },
    ]);

    const [stats] = await pageRepo.getStats(['/p']);

    expect(stats?.reactions.find((r) => r.key === 'heart')?.count).toBe(34);
  });

  it('returns every configured reaction kind, including those at zero', async () => {
    await makePage('/p');

    const [stats] = await pageRepo.getStats(['/p']);

    // A stable set keeps the widget from reflowing as counts appear.
    expect(stats?.reactions.map((r) => r.key)).toEqual([
      'heart',
      'thumbs_up',
      'thumbs_down',
      'fire',
      'black_cat',
    ]);
    expect(stats?.reactions.every((r) => r.count === 0)).toBe(true);
  });

  it('answers for an unknown page with zeroes instead of omitting it', async () => {
    const stats = await pageRepo.getStats(['/never-seen']);

    expect(stats).toHaveLength(1);
    expect(stats[0]).toMatchObject({ path: '/never-seen', pageviews: 0, commentCount: 0 });
    expect(stats[0]?.reactions).toHaveLength(5);
  });

  it('counts only approved comments', async () => {
    const pageId = await makePage('/p');
    await makeComment({ pageId, status: 'approved' });
    await makeComment({ pageId, status: 'pending' });

    const [stats] = await pageRepo.getStats(['/p']);

    expect(stats?.commentCount).toBe(1);
  });
});

describe('PageRepository.incrementPageview', () => {
  it('creates the page on first view', async () => {
    expect(await pageRepo.incrementPageview('/brand-new')).toBe(1);
  });

  it('increments an existing page', async () => {
    await makePage('/p', 41);
    expect(await pageRepo.incrementPageview('/p')).toBe(42);
  });

  it('loses no increments under concurrency', async () => {
    // A read-modify-write would drop most of these; the increment happens
    // inside Postgres precisely so it cannot.
    await makePage('/p', 0);

    await Promise.all(Array.from({ length: 20 }, () => pageRepo.incrementPageview('/p')));

    const [stats] = await pageRepo.getStats(['/p']);
    expect(stats?.pageviews).toBe(20);
  });
});
