import { describe, expect, it } from 'vitest';
import { buildThreads, type ThreadableComment } from './thread.js';

interface TestComment extends ThreadableComment {
  likeCount: number;
}

const at = (iso: string): Date => new Date(iso);

const c = (id: string, over: Partial<TestComment> = {}): TestComment => ({
  id,
  parentId: null,
  rootId: id,
  createdAt: at('2025-01-01T00:00:00Z'),
  isSticky: false,
  likeCount: 0,
  ...over,
});

describe('buildThreads', () => {
  it('nests replies under their root', () => {
    const root = c('r', { createdAt: at('2025-01-01T00:00:00Z') });
    const reply = c('a', { parentId: 'r', rootId: 'r', createdAt: at('2025-01-02T00:00:00Z') });

    const threads = buildThreads([reply, root], 'latest');

    expect(threads).toHaveLength(1);
    expect(threads[0]?.root.id).toBe('r');
    expect(threads[0]?.replies.map((x) => x.id)).toEqual(['a']);
  });

  it('orders replies oldest-first even when roots are newest-first', () => {
    const root = c('r');
    const early = c('a', { parentId: 'r', rootId: 'r', createdAt: at('2025-01-02T00:00:00Z') });
    const late = c('b', { parentId: 'r', rootId: 'r', createdAt: at('2025-01-03T00:00:00Z') });

    const threads = buildThreads([late, early, root], 'latest');

    // Reading a conversation backwards makes it incoherent, so replies never
    // follow the root ordering.
    expect(threads[0]?.replies.map((x) => x.id)).toEqual(['a', 'b']);
  });

  it.each([
    ['latest', ['new', 'old']],
    ['oldest', ['old', 'new']],
  ] as const)('sorts roots by %s', (sort, expected) => {
    const old = c('old', { createdAt: at('2025-01-01T00:00:00Z') });
    const recent = c('new', { createdAt: at('2025-06-01T00:00:00Z') });

    expect(buildThreads([old, recent], sort).map((t) => t.root.id)).toEqual(expected);
  });

  it('sorts by score when hottest, falling back to recency on a tie', () => {
    const popular = c('popular', { likeCount: 10, createdAt: at('2025-01-01T00:00:00Z') });
    const tiedOld = c('tied-old', { likeCount: 3, createdAt: at('2025-01-01T00:00:00Z') });
    const tiedNew = c('tied-new', { likeCount: 3, createdAt: at('2025-02-01T00:00:00Z') });

    const order = buildThreads([tiedOld, tiedNew, popular], 'hottest', (x) => x.likeCount).map(
      (t) => t.root.id,
    );

    expect(order).toEqual(['popular', 'tied-new', 'tied-old']);
  });

  it('floats sticky roots to the top in every ordering', () => {
    const pinned = c('pinned', { isSticky: true, createdAt: at('2020-01-01T00:00:00Z') });
    const recent = c('recent', { createdAt: at('2025-06-01T00:00:00Z') });

    for (const sort of ['latest', 'oldest', 'hottest'] as const) {
      expect(buildThreads([recent, pinned], sort)[0]?.root.id).toBe('pinned');
    }
  });

  it('promotes a reply to a root when its root is not in this page of results', () => {
    // Losing a comment is worse than flattening one, so an orphan is shown
    // rather than silently dropped.
    const orphan = c('o', { parentId: 'missing', rootId: 'missing' });

    const threads = buildThreads([orphan], 'latest');

    expect(threads).toHaveLength(1);
    expect(threads[0]?.root.id).toBe('o');
  });

  it('handles an empty input', () => {
    expect(buildThreads([], 'latest')).toEqual([]);
  });

  it('keeps every comment exactly once', () => {
    const root = c('r');
    const replies = ['a', 'b', 'c'].map((id, i) =>
      c(id, { parentId: 'r', rootId: 'r', createdAt: at(`2025-01-0${i + 2}T00:00:00Z`) }),
    );
    const other = c('other');

    const threads = buildThreads([...replies, root, other], 'latest');
    const seen = threads.flatMap((t) => [t.root.id, ...t.replies.map((x) => x.id)]);

    expect(seen.sort()).toEqual(['a', 'b', 'c', 'other', 'r']);
  });
});
