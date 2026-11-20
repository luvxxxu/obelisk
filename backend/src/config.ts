import { resolve } from 'node:path';

const publicUrl = (process.env.PUBLIC_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
const signupMode = (process.env.SIGNUP_MODE ?? 'first').toLowerCase();
const production = process.env.NODE_ENV === 'production';

const smtpUrl = process.env.SMTP_URL?.trim() || null;

/**
 * A mailbox's own SMTP (Gmail, Naver, Proton…) only sends as that mailbox, so when the SMTP login
 * is an address it is the sender. Otherwise a no-reply address on the public host.
 */
export function defaultMailFrom(smtp: string | null, publicOrigin: string): string {
  if (smtp) {
    try {
      const user = decodeURIComponent(new URL(smtp).username);
      if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(user)) return `Obelisk <${user}>`;
    } catch {}
  }
  try {
    return `Obelisk <no-reply@${new URL(publicOrigin).hostname}>`;
  } catch {
    return 'Obelisk <no-reply@localhost>';
  }
}

export const config = {
  production,
  port: Number(process.env.PORT ?? 4000),
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://obelisk:obelisk@localhost:5432/obelisk',
  /** Public origin users and AI clients reach the app at (the web container). */
  publicUrl,
  mcpUrl: `${publicUrl}/mcp`,
  /** first = only the very first account may sign up; open = anyone; closed = nobody. */
  signupMode: (['first', 'open', 'closed'].includes(signupMode) ? signupMode : 'first') as
    | 'first'
    | 'open'
    | 'closed',
  secureCookies: publicUrl.startsWith('https://'),
  sessionDays: 30,
  /**
   * Outgoing mail (password reset links) through any SMTP server: your mailbox's,
   * e.g. smtps://you@gmail.com:app-password@smtp.gmail.com:465, or for your own domain Cloudflare Email Service:
   * smtps://api_token:<token>@smtp.mx.cloudflare.net:465 (implicit TLS only) with MAIL_FROM set.
   * Unset in production = "비밀번호 찾기" is hidden; unset in development = mails are printed to the server log.
   */
  smtpUrl,
  /** Sender; defaults to the SMTP login when that is an address (see defaultMailFrom). */
  mailFrom: process.env.MAIL_FROM?.trim() || defaultMailFrom(smtpUrl, publicUrl),
  passwordResetMinutes: 60,
  oauthAccessSeconds: 60 * 60,
  oauthRefreshDays: 90,
  migrationsDir: process.env.MIGRATIONS_DIR ?? resolve(import.meta.dir, '../drizzle'),
  skillsDir: process.env.SKILLS_DIR ?? resolve(import.meta.dir, '../../skills'),
  /**
   * Let outgoing webhooks reach private/loopback addresses (a LAN receiver, local testing).
   * Off in production unless WEBHOOK_ALLOW_PRIVATE=true, so a webhook can't probe the server's network.
   */
  webhookAllowPrivate: process.env.WEBHOOK_ALLOW_PRIVATE
    ? process.env.WEBHOOK_ALLOW_PRIVATE === 'true'
    : process.env.NODE_ENV !== 'production',
  /**
   * Let a user's Jev base URL point at private/loopback or plain-http addresses (a self-hosted System One
   * server on the LAN, local testing). Off in production unless JEV_ALLOW_PRIVATE=true, for the same reason.
   */
  jevAllowPrivate: process.env.JEV_ALLOW_PRIVATE
    ? process.env.JEV_ALLOW_PRIVATE === 'true'
    : process.env.NODE_ENV !== 'production',
  /**
   * Let "다른 서버에서 가져오기" pull from private/loopback or plain-http addresses (two servers on one
   * LAN, local testing). Off in production unless MIGRATION_ALLOW_PRIVATE=true, so a pasted link can't
   * make this server probe its own network.
   */
  migrationAllowPrivate: process.env.MIGRATION_ALLOW_PRIVATE
    ? process.env.MIGRATION_ALLOW_PRIVATE === 'true'
    : process.env.NODE_ENV !== 'production',
  /** 이전 링크 lifetime. */
  migrationCodeMinutes: 30,
};

export const SESSION_COOKIE = 'obelisk_session';
