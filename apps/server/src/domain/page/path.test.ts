import { describe, expect, it } from 'vitest';
import { normalizePath } from './path.js';

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
    ['  /post  ', '/post'],
    ['/', '/'],
  ])('%s → %s', (input, expected) => {
    expect(normalizePath(input)).toBe(expected);
  });

  it('is idempotent', () => {
    for (const raw of ['/Post/', 'post?x=1', 'https://example.com/a//b/', '/']) {
      expect(normalizePath(normalizePath(raw))).toBe(normalizePath(raw));
    }
  });

  it('collapses the spellings that would otherwise split one page in two', () => {
    const variants = ['/my-post', '/my-post/', '/My-Post', '/my-post?ref=twitter', '/my-post#top'];
    expect(new Set(variants.map(normalizePath)).size).toBe(1);
  });
});
