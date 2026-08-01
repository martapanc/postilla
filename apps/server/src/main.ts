import { buildApp } from './app.js';
import { createContainer } from './container.js';
import { loadConfig } from './config/env.js';

/**
 * The single entry point. The fork it replaces had four (Vercel, Netlify,
 * Docker, dev), each subtly different, which is how the deployments drifted.
 */

async function main(): Promise<void> {
  const config = loadConfig();
  const container = createContainer(config);
  const app = await buildApp(container);

  const close = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutting down');
    await app.close();
    await container.shutdown();
    process.exit(0);
  };

  process.on('SIGTERM', () => void close('SIGTERM'));
  process.on('SIGINT', () => void close('SIGINT'));

  await app.listen({ host: config.http.host, port: config.http.port });
}

main().catch((error: unknown) => {
  console.error('Failed to start:', error instanceof Error ? error.message : error);
  process.exit(1);
});
