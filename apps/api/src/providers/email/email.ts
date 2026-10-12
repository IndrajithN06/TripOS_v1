import { Logger } from '@nestjs/common';
import { config } from '../../config/config';

export interface EmailMessage { to: string; subject: string; text: string }
export interface EmailProvider { readonly name: string; send(m: EmailMessage): Promise<void> }
export const EMAIL = Symbol('EMAIL');

/** Development adapter: logs the message (including invite links) and keeps it in memory for tests. */
export class ConsoleEmail implements EmailProvider {
  readonly name = 'console';
  static readonly outbox: EmailMessage[] = [];
  private readonly log = new Logger('Email[console]');
  async send(m: EmailMessage) {
    ConsoleEmail.outbox.push(m);
    this.log.log(`To: ${m.to} | ${m.subject}\n${m.text}`);
  }
}

export class ResendEmail implements EmailProvider {
  readonly name = 'resend';
  async send(m: EmailMessage) {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST', signal: AbortSignal.timeout(15000),
      headers: { Authorization: `Bearer ${config().EMAIL_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: config().EMAIL_FROM, to: m.to, subject: m.subject, text: m.text }),
    });
    if (!res.ok) throw new Error(`Email provider returned ${res.status}`);
  }
}

export function createEmail(): EmailProvider {
  return config().EMAIL_PROVIDER === 'resend' ? new ResendEmail() : new ConsoleEmail();
}
