import nodemailer from 'nodemailer';
import type { NotificationChannel } from './channels.js';

/**
 * Email, via SMTP. Locally this points at Mailpit from docker-compose, so
 * notification work never risks a real send.
 */
export function createEmailChannel(options: {
  host: string;
  port: number;
  secure: boolean;
  user?: string | undefined;
  password?: string | undefined;
  from: string;
  to: string;
}): NotificationChannel {
  const transport = nodemailer.createTransport({
    host: options.host,
    port: options.port,
    secure: options.secure,
    ...(options.user && options.password
      ? { auth: { user: options.user, pass: options.password } }
      : {}),
  });

  return {
    id: 'email',
    format: 'email-html',
    async send(message) {
      await transport.sendMail({
        from: options.from,
        to: options.to,
        subject: message.subject,
        html: message.body,
      });
    },
  };
}
