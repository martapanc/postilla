import { describe, expect, it } from 'vitest';
import { loadConfig } from './env.js';

const valid = {
  DATABASE_URL: 'postgres://postilla@localhost:5432/postilla',
  SERVER_URL: 'http://localhost:8360',
  SITE_NAME: 'Test Site',
  SECRET_KEY: 'a'.repeat(32),
} satisfies NodeJS.ProcessEnv;

describe('loadConfig', () => {
  it('applies defaults for optional settings', () => {
    const config = loadConfig(valid);

    expect(config.env).toBe('development');
    expect(config.http.port).toBe(8360);
    expect(config.locale.default).toBe('en');
    expect(config.http.allowedOrigins).toEqual([]);
  });

  it('reports every problem at once rather than only the first', () => {
    expect(() => loadConfig({ SITE_NAME: 'x' })).toThrowError(
      /DATABASE_URL[\s\S]*SERVER_URL[\s\S]*SECRET_KEY/,
    );
  });

  it('accepts WALINE_SITE_NAME as a deprecated alias', () => {
    const { SITE_NAME: _omitted, ...withoutSiteName } = valid;
    const config = loadConfig({ ...withoutSiteName, WALINE_SITE_NAME: 'Legacy Name' });

    expect(config.site.name).toBe('Legacy Name');
  });

  it('prefers SITE_NAME when both are set', () => {
    const config = loadConfig({ ...valid, WALINE_SITE_NAME: 'Legacy Name' });

    expect(config.site.name).toBe('Test Site');
  });

  it('requires a site name under either spelling', () => {
    const { SITE_NAME: _omitted, ...withoutSiteName } = valid;

    expect(() => loadConfig(withoutSiteName)).toThrowError(/SITE_NAME is required/);
  });

  it('rejects a secret key that is too short to be worth having', () => {
    expect(() => loadConfig({ ...valid, SECRET_KEY: 'short' })).toThrowError(
      /SECRET_KEY must be at least 32 characters/,
    );
  });

  it('rejects a non-postgres database url', () => {
    expect(() => loadConfig({ ...valid, DATABASE_URL: 'mysql://localhost/db' })).toThrowError(
      /DATABASE_URL/,
    );
  });

  it('parses a comma-separated origin list, tolerating whitespace', () => {
    const config = loadConfig({
      ...valid,
      ALLOWED_ORIGINS: 'https://a.example, https://b.example ,',
    });

    expect(config.http.allowedOrigins).toEqual(['https://a.example', 'https://b.example']);
  });
});
