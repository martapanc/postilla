import { describe, expect, it } from 'vitest';
import { leanCommentSchema, leanUserSchema } from './records.js';
import {
  buildPages,
  hashEmail,
  mapStatus,
  normalizePath,
  parseUserType,
  resolveRoot,
  transformComments,
  transformReactions,
  transformUsers,
} from './transform.js';
import type { LeanComment, LeanCounter } from './records.js';
import type { z } from 'zod';

/**
 * Takes the *raw* export shape (timestamps as strings) and returns the parsed
 * record, so tests exercise the same parse path the CLI does.
 */
type RawComment = z.input<typeof leanCommentSchema>;

const comment = (over: Partial<RawComment> & { objectId: string }): LeanComment =>
  leanCommentSchema.parse({
    comment: 'hello',
    url: '/post',
    nick: 'Someone',
    mail: 'a@example.com',
    link: '',
    ip: '203.0.113.1',
    ua: 'Mozilla/5.0',
    status: 'approved',
    insertedAt: '2025-08-29T12:12:27.000Z',
    createdAt: '2025-11-24T18:18:28.580Z',
    updatedAt: '2025-11-24T18:32:38.513Z',
    ...over,
  });

const counter = (over: Partial<LeanCounter> & { objectId: string; url: string }): LeanCounter => ({
  time: 0,
  createdAt: new Date('2025-11-11T23:27:40.927Z'),
  updatedAt: new Date('2025-11-14T18:25:17.625Z'),
  ...over,
});

describe('normalizePath', () => {
  it.each([
    ['/post', '/post'],
    ['/post/', '/post'],
    ['/Post', '/post'],
    ['/post?utm_source=x', '/post'],
    ['/post#comments', '/post'],
    ['post', '/post'],
    ['//post//deep//', '/post/deep'],
    ['https://example.com/post/', '/post'],
    ['/', '/'],
  ])('%s → %s', (input, expected) => {
    expect(normalizePath(input)).toBe(expected);
  });

  it('is idempotent', () => {
    for (const raw of ['/Post/', 'post?x=1', 'https://example.com/a//b/']) {
      expect(normalizePath(normalizePath(raw))).toBe(normalizePath(raw));
    }
  });
});

describe('timestamps', () => {
  /**
   * The highest-risk item in the whole migration. LeanCloud returns ISO-8601
   * UTC; the old schema stored `timestamp without time zone`. If anything in
   * this chain applies a local-time offset, every comment silently shifts.
   */
  it('preserves the exact UTC instant, independent of the host timezone', () => {
    const parsed = comment({ objectId: 'a', insertedAt: '2025-08-29T12:12:27.000Z' });

    expect(parsed.insertedAt.toISOString()).toBe('2025-08-29T12:12:27.000Z');
    expect(parsed.insertedAt.getTime()).toBe(Date.UTC(2025, 7, 29, 12, 12, 27, 0));

    const [row] = transformComments([parsed]).rows;
    expect(row?.createdAt.toISOString()).toBe('2025-08-29T12:12:27.000Z');
  });

  it('rejects a timestamp without an explicit UTC marker', () => {
    expect(() => comment({ objectId: 'a', insertedAt: '2025-08-29 12:12:27' })).toThrowError();
  });

  it('takes insertedAt, not createdAt, as the authoring time', () => {
    // Real data: 5 of 16 comments differ by more than a day because they were
    // imported into LeanCloud months after being written.
    const [row] = transformComments([
      comment({
        objectId: 'a',
        insertedAt: '2025-08-29T12:12:27.000Z',
        createdAt: '2025-11-24T18:18:28.580Z',
      }),
    ]).rows;

    expect(row?.createdAt.toISOString()).toBe('2025-08-29T12:12:27.000Z');
  });
});

describe('threading', () => {
  it('treats a top-level comment as its own root', () => {
    const byId = new Map([['a', comment({ objectId: 'a' })]]);
    expect(resolveRoot('a', byId)).toEqual({ rootId: 'a', depth: 0 });
  });

  it('walks a nested chain to the true root', () => {
    const byId = new Map(
      [
        comment({ objectId: 'a' }),
        comment({ objectId: 'b', pid: 'a' }),
        comment({ objectId: 'c', pid: 'b' }),
      ].map((c) => [c.objectId, c]),
    );

    expect(resolveRoot('c', byId)).toEqual({ rootId: 'a', depth: 2 });
  });

  it('recomputes the root rather than trusting a wrong stored rid', () => {
    const rows = transformComments([
      comment({ objectId: 'a' }),
      comment({ objectId: 'b', pid: 'a' }),
      // rid claims 'b' is its own root, which contradicts pid.
      comment({ objectId: 'c', pid: 'b', rid: 'b' }),
    ]);

    expect(rows.notes.find((n) => n.kind === 'rid_disagreement')).toBeDefined();
    expect(rows.notes.find((n) => n.kind === 'max_thread_depth')?.detail).toBe('2');
  });

  it('rejects a comment whose parent is missing rather than orphaning it', () => {
    const { rows, rejections } = transformComments([comment({ objectId: 'b', pid: 'ghost' })]);

    expect(rows).toHaveLength(0);
    expect(rejections[0]).toMatchObject({ objectId: 'b' });
    expect(rejections[0]?.reason).toMatch(/does not exist/);
  });

  it('rejects a cycle instead of looping forever', () => {
    const { rejections } = transformComments([
      comment({ objectId: 'a', pid: 'b' }),
      comment({ objectId: 'b', pid: 'a' }),
    ]);

    expect(rejections).toHaveLength(2);
    expect(rejections[0]?.reason).toMatch(/cycle/);
  });
});

describe('buildPages', () => {
  it('unions Counter and Comment urls into one row per path', () => {
    const { pages } = buildPages(
      [counter({ objectId: 'c1', url: '/a', time: 10 })],
      [comment({ objectId: 'x', url: '/b' })],
    );

    expect([...pages.keys()].sort()).toEqual(['/a', '/b']);
    expect(pages.get('/a')?.pageviews).toBe(10);
    expect(pages.get('/b')?.pageviews).toBe(0);
  });

  it('sums pageviews when two Counter rows normalize to one path', () => {
    const { pages, notes } = buildPages(
      [
        counter({ objectId: 'c1', url: '/a', time: 10 }),
        counter({ objectId: 'c2', url: '/a/', time: 5 }),
      ],
      [],
    );

    expect(pages.get('/a')?.pageviews).toBe(15);
    expect(notes.some((n) => n.kind === 'counter_merged')).toBe(true);
  });

  it('reports when distinct urls collapse, since that can misattach comments', () => {
    const { notes } = buildPages(
      [counter({ objectId: 'c1', url: '/a' }), counter({ objectId: 'c2', url: '/A/' })],
      [],
    );

    const merge = notes.find((n) => n.kind === 'path_normalization_merge');
    expect(merge?.detail).toContain('/a');
  });
});

describe('transformReactions', () => {
  it('converts positional columns to rows and drops zeroes', () => {
    const { rows } = transformReactions([
      counter({ objectId: 'c1', url: '/a', reaction0: 3, reaction1: 0, reaction4: 0 }),
    ]);

    expect(rows).toEqual([{ path: '/a', legacyIndex: 0, count: 3 }]);
  });

  it('sums counts across counters that share a path', () => {
    const { rows } = transformReactions([
      counter({ objectId: 'c1', url: '/a', reaction0: 3 }),
      counter({ objectId: 'c2', url: '/a/', reaction0: 4 }),
    ]);

    expect(rows).toEqual([{ path: '/a', legacyIndex: 0, count: 7 }]);
  });
});

describe('users', () => {
  const baseUser = {
    objectId: 'u1',
    display_name: 'Admin',
    email: '  Admin@Example.COM ',
    password: '$P$Bsomehash',
    type: 'administrator',
    '2fa': 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP',
    avatar: '',
    url: '',
    label: '',
    github: '',
    twitter: '',
    facebook: '',
    google: '',
    weibo: '',
    qq: '',
    createdAt: '2025-11-11T22:37:18.134Z',
    updatedAt: '2026-01-30T08:54:15.336Z',
  };

  it('splits the overloaded type column', () => {
    expect(parseUserType('administrator')).toMatchObject({ role: 'admin', emailVerified: true });
    expect(parseUserType('guest')).toMatchObject({ role: 'moderator', emailVerified: true });

    const verify = parseUserType('verify:abc123:1700000000000');
    expect(verify).toMatchObject({ role: 'moderator', emailVerified: false });
    expect(verify.pendingVerification?.code).toBe('abc123');
  });

  it('carries the TOTP secret across byte-for-byte', () => {
    // If this ever changes, the admin is locked out of the new dashboard.
    const [row] = transformUsers([leanUserSchema.parse(baseUser)]).rows;

    expect(row?.totpSecret).toBe('JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP');
    expect(row?.totpEnabledAt).not.toBeNull();
  });

  it('keeps the phpass hash and marks the algorithm for rehash on login', () => {
    const [row] = transformUsers([leanUserSchema.parse(baseUser)]).rows;

    expect(row?.passwordHash).toBe('$P$Bsomehash');
    expect(row?.passwordAlgo).toBe('phpass');
  });

  it('normalizes the email so the unique index behaves', () => {
    const [row] = transformUsers([leanUserSchema.parse(baseUser)]).rows;
    expect(row?.email).toBe('admin@example.com');
  });

  it('records any discarded social identity rather than dropping it silently', () => {
    const { notes } = transformUsers([leanUserSchema.parse({ ...baseUser, github: 'octocat' })]);

    expect(notes.find((n) => n.kind === 'social_identity_dropped')?.detail).toContain('github');
  });

  it('says nothing when there were no social identities to discard', () => {
    const { notes } = transformUsers([leanUserSchema.parse(baseUser)]);
    expect(notes.filter((n) => n.kind === 'social_identity_dropped')).toHaveLength(0);
  });
});

describe('field mapping', () => {
  it('maps waiting to pending', () => {
    expect(mapStatus('waiting')).toBe('pending');
    expect(mapStatus('approved')).toBe('approved');
    expect(mapStatus('spam')).toBe('spam');
  });

  it('hashes emails case- and whitespace-insensitively', () => {
    expect(hashEmail('  A@B.COM ')).toBe(hashEmail('a@b.com'));
    expect(hashEmail(null)).toBeNull();
  });

  it('treats empty strings as absent', () => {
    const parsed = comment({ objectId: 'a', mail: '', link: '', ip: '' });
    expect(parsed.mail).toBeNull();
    expect(parsed.link).toBeNull();

    const [row] = transformComments([parsed]).rows;
    expect(row?.authorEmailHash).toBeNull();
  });
});
