/**
 * A page is identified by its normalized path, and this function is the only
 * definition of what "normalized" means. Both the API and the LeanCloud
 * migrator call it, so a comment posted today and a comment imported from 2025
 * land on the same page row.
 *
 * Pure by construction — no IO, no config, no clock.
 */
export function normalizePath(raw: string): string {
  let path = raw.trim();

  // Tolerate absolute URLs; we only ever key on the path.
  if (/^https?:\/\//i.test(path)) {
    try {
      path = new URL(path).pathname;
    } catch {
      /* fall through and treat it as a path */
    }
  }

  path = path.split('#')[0] ?? path;
  path = path.split('?')[0] ?? path;
  path = path.toLowerCase();
  if (!path.startsWith('/')) path = `/${path}`;
  // Collapse duplicate slashes, then drop a trailing one (but keep the root).
  path = path.replaceAll(/\/{2,}/g, '/');
  if (path.length > 1) path = path.replace(/\/+$/, '');

  return path;
}
