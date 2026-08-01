import type { PageStatsResponse, RecordPageviewResponse } from '@postilla/contract';
import { normalizePath } from '../../domain/page/path.js';
import type { PageRepository } from '../../ports/repositories.js';

export function createGetPageStats(repo: PageRepository) {
  return async function getPageStats(paths: string[]): Promise<PageStatsResponse> {
    // Normalizing before the query means /Post/ and /post are one lookup, and
    // deduplicating means a caller repeating a path does not pay for it twice.
    const normalized = [...new Set(paths.map(normalizePath))];
    const pages = await repo.getStats(normalized);
    return { pages };
  };
}

export function createRecordPageview(repo: PageRepository) {
  return async function recordPageview(path: string): Promise<RecordPageviewResponse> {
    const normalized = normalizePath(path);
    const pageviews = await repo.incrementPageview(normalized);
    return { path: normalized, pageviews };
  };
}
