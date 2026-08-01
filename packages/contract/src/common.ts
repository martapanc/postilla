import { z } from 'zod';

/**
 * The wire contract, declared once. The server validates requests and
 * serializes responses from these schemas, and generates its OpenAPI document
 * from them; the admin dashboard and the embed widget import the same types.
 *
 * A breaking API change therefore becomes a compile error in the clients
 * rather than a runtime surprise. This package has no runtime dependency
 * beyond zod, so a browser bundle pays almost nothing to import it.
 */

/** A page path as a caller may supply it; normalized server-side. */
export const pagePath = z
  .string()
  .min(1)
  .max(2048)
  .describe('Page path, e.g. /my-post. Absolute URLs are accepted and reduced to their path.');

export const localeCode = z.enum(['en', 'it']);

export const paginationQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(10),
});

export const paginationMeta = z.object({
  page: z.number().int(),
  pageSize: z.number().int(),
  total: z.number().int().describe('Total matching root comments, ignoring pagination.'),
  totalPages: z.number().int(),
});

/**
 * RFC 9457 problem+json. Clients switch on `code` and render their own
 * localized message; `detail` is for humans reading logs, never for display.
 */
export const problemDetails = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number().int(),
  code: z.string(),
  detail: z.string(),
  instance: z.string(),
  errors: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
});

export type PagePath = z.infer<typeof pagePath>;
export type LocaleCode = z.infer<typeof localeCode>;
export type PaginationMeta = z.infer<typeof paginationMeta>;
export type ProblemDetails = z.infer<typeof problemDetails>;
