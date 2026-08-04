import type { MessageFormat, RenderedMessage } from '../../domain/notifications/events.js';

/**
 * A delivery destination. Each channel declares the format it wants, and the
 * renderer produces exactly that — so adding a channel never means teaching
 * every template about it.
 */
export interface NotificationChannel {
  readonly id: string;
  readonly format: MessageFormat;
  send(message: RenderedMessage): Promise<void>;
}

/** Non-2xx from a webhook is a delivery failure, so the outbox will retry. */
async function assertOk(response: Response, channel: string): Promise<void> {
  if (response.ok) return;
  const detail = await response.text().catch(() => '');
  throw new Error(`${channel} responded ${String(response.status)}: ${detail.slice(0, 200)}`);
}

export function createTelegramChannel(options: {
  botToken: string;
  chatId: string;
  timeoutMs?: number;
}): NotificationChannel {
  return {
    id: 'telegram',
    format: 'telegram-html',
    async send(message) {
      const response = await fetch(`https://api.telegram.org/bot${options.botToken}/sendMessage`, {
        method: 'POST',
        // JSON, not multipart: the fork used FormData, which made the
        // payload harder to inspect for no benefit.
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: options.chatId,
          text: message.body,
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: true },
        }),
        signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
      });

      await assertOk(response, 'Telegram');
    },
  };
}

export function createDiscordChannel(options: {
  webhookUrl: string;
  timeoutMs?: number;
}): NotificationChannel {
  return {
    id: 'discord',
    format: 'discord-markdown',
    async send(message) {
      const response = await fetch(options.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: message.body,
          // The comment author's name must never become a mention.
          allowed_mentions: { parse: [] },
        }),
        signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
      });

      await assertOk(response, 'Discord');
    },
  };
}

/** Generic webhook, for anything not worth a dedicated adapter. */
export function createWebhookChannel(options: {
  url: string;
  timeoutMs?: number;
}): NotificationChannel {
  return {
    id: 'webhook',
    format: 'plain-text',
    async send(message) {
      const response = await fetch(options.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(message),
        signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
      });

      await assertOk(response, 'Webhook');
    },
  };
}
