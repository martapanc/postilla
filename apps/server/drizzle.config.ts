import { defineConfig } from 'drizzle-kit';

// drizzle-kit runs outside the app, so it reads the environment directly.
const url = process.env['DATABASE_URL'];
if (!url) {
  throw new Error('DATABASE_URL is required to run drizzle-kit');
}

export default defineConfig({
  schema: './src/infrastructure/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: { url },
  strict: true,
  verbose: true,
});
