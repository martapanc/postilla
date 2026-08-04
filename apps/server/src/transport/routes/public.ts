import {
  commentCountQuery,
  createCommentBody,
  createCommentResponse,
  commentCountResponse,
  listCommentsQuery,
  listCommentsResponse,
  pageStatsQuery,
  pageStatsResponse,
  problemDetails,
  recordPageviewBody,
  recordPageviewResponse,
  recordReactionBody,
  recordReactionResponse,
} from '@postilla/contract';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

/**
 * The endpoints the embed widget calls. All are public and unauthenticated,
 * so each carries its own rate limit — the global limiter is off precisely
 * because these budgets differ so much.
 */
export async function registerPublicRoutes(app: FastifyInstance): Promise<void> {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const { listComments, getPageStats, recordPageview, createComment, recordReaction } =
    app.container.useCases;

  typed.get(
    '/api/comments',
    {
      schema: {
        tags: ['comments'],
        summary: 'List approved comment threads for a page',
        description:
          'Pagination applies to root comments; every reply belonging to a returned root is included, so a thread is never split across pages.',
        querystring: listCommentsQuery,
        response: { 200: listCommentsResponse, 400: problemDetails },
      },
      config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
    },
    async (request) => listComments(request.query),
  );

  typed.get(
    '/api/comments/count',
    {
      schema: {
        tags: ['comments'],
        summary: 'Approved comment counts for up to 100 pages',
        querystring: commentCountQuery,
        response: { 200: commentCountResponse, 400: problemDetails },
      },
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    },
    async (request) => {
      const counts = await app.container.repositories.comments.countApprovedByPaths(
        request.query.paths,
      );
      return { counts: [...counts].map(([path, count]) => ({ path, count })) };
    },
  );

  typed.get(
    '/api/pages',
    {
      schema: {
        tags: ['pages'],
        summary: 'Pageviews, comment counts and reaction totals for up to 100 pages',
        querystring: pageStatsQuery,
        response: { 200: pageStatsResponse, 400: problemDetails },
      },
      config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
    },
    async (request) => getPageStats(request.query.paths),
  );

  typed.post(
    '/api/pageviews',
    {
      schema: {
        tags: ['pages'],
        summary: 'Record a pageview',
        description: 'Creates the page on first view. Increments atomically in the database.',
        body: recordPageviewBody,
        response: { 200: recordPageviewResponse, 400: problemDetails, 429: problemDetails },
      },
      // Tighter than the reads: this one writes, and it is trivially forgeable.
      // Real abuse protection arrives with the write path in M3.
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    },
    async (request) => recordPageview(request.body.path),
  );

  typed.post(
    '/api/comments',
    {
      schema: {
        tags: ['comments'],
        summary: 'Submit a comment',
        description:
          'Returns 200 with status `pending` when the comment was accepted but is awaiting moderation. Spam is rejected with 422.',
        body: createCommentBody,
        response: {
          201: createCommentResponse,
          400: problemDetails,
          403: problemDetails,
          404: problemDetails,
          422: problemDetails,
          429: problemDetails,
        },
      },
      // The only unauthenticated write. The domain applies its own per-author
      // limits on top; this one is a coarse per-IP backstop.
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const result = await createComment({
        path: request.body.path,
        parentId: request.body.parentId ?? null,
        bodyMarkdown: request.body.comment,
        authorName: request.body.nick,
        authorEmail: request.body.mail ?? null,
        authorUrl: request.body.link ?? null,
        authorIp: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
        captchaToken: request.body.captchaToken ?? null,
        locale: request.body.locale ?? app.container.config.locale.default,
        // Authentication arrives in M5; until then every submission is a guest.
        actor: null,
      });

      return reply.status(201).send(result);
    },
  );

  typed.post(
    '/api/reactions',
    {
      schema: {
        tags: ['pages'],
        summary: 'Add or remove a reaction',
        description:
          'Idempotent per visitor: reacting twice adds one. Returns both the count for this reaction and the page total.',
        body: recordReactionBody,
        response: { 200: recordReactionResponse, 400: problemDetails, 404: problemDetails },
      },
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    },
    async (request) => {
      const result = await recordReaction({
        path: request.body.path,
        kindKey: request.body.kind,
        remove: request.body.remove,
        visitorIp: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
      });

      return {
        kind: result.kindKey,
        kindTotal: result.kindTotal,
        pageTotal: result.pageTotal,
        active: result.active,
      };
    },
  );
}
