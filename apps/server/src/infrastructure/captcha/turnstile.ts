import type { CaptchaVerifier } from '../../ports/services.js';

/**
 * Cloudflare Turnstile, behind the CaptchaVerifier port.
 *
 * Unlike the spam checker this fails *closed*: a captcha that cannot be
 * verified has not been passed. Turnstile is the main defence against
 * automated comment floods, so treating an outage as "everyone is human"
 * would remove the protection precisely when it is being attacked.
 */
export function createTurnstileVerifier(options: {
  secretKey: string;
  timeoutMs?: number;
  onError?: (error: unknown) => void;
}): CaptchaVerifier {
  const endpoint = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
  const timeoutMs = options.timeoutMs ?? 5_000;

  return {
    async verify(token: string | null, remoteIp: string | null): Promise<boolean> {
      if (!token) return false;

      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            secret: options.secretKey,
            response: token,
            ...(remoteIp ? { remoteip: remoteIp } : {}),
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });

        if (!response.ok) {
          options.onError?.(new Error(`Turnstile responded ${String(response.status)}`));
          return false;
        }

        const result = (await response.json()) as { success?: unknown };
        return result.success === true;
      } catch (error: unknown) {
        options.onError?.(error);
        return false;
      }
    },
  };
}

/**
 * Used when no Turnstile secret is configured. Returns true so callers need no
 * special case — the decision to run without a captcha is made once, in config.
 */
export const noopCaptchaVerifier: CaptchaVerifier = {
  verify: () => Promise.resolve(true),
};
