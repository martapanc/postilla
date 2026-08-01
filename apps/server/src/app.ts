import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { registerErrorHandler } from './transport/error-handler.js';
import { registerHealthRoutes } from './transport/routes/health.js';
import type { Container } from './container.js';

declare module 'fastify' {
  interface FastifyInstance {
    container: Container;
  }
}

export async function buildApp(container: Container): Promise<FastifyInstance> {
  const { config } = container;

  const app = Fastify({
    logger: {
      level: config.log.level,
      // Comments carry email addresses and IPs. Redaction is configured once,
      // here, so no individual log call has to remember.
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'res.headers["set-cookie"]',
          '*.mail',
          '*.email',
          '*.authorEmail',
          '*.ip',
          '*.authorIp',
          '*.password',
          '*.passwordHash',
          '*.totpSecret',
        ],
        censor: '[redacted]',
      },
      ...(config.isProduction ? {} : { transport: { target: 'pino-pretty' } }),
    },
    // Trust the proxy in production so client IPs are real; trusting it in
    // development would let anyone spoof X-Forwarded-For against the rate limiter.
    trustProxy: config.isProduction,
  }).withTypeProvider<ZodTypeProvider>();

  // One zod declaration per route validates the request, types the handler,
  // and constrains the response serializer.
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.decorate('container', container);

  await app.register(helmet, {
    // The widget is embedded cross-origin by design.
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  });

  await app.register(cors, {
    origin: config.http.allowedOrigins.length > 0 ? config.http.allowedOrigins : false,
    credentials: true,
  });

  await app.register(rateLimit, {
    global: false, // Opt in per route; the limits differ far too much to share one.
  });

  registerErrorHandler(app);
  await app.register(registerHealthRoutes);

  return app;
}
