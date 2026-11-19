import { resolve } from 'node:path';

const publicUrl = (process.env.PUBLIC_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
const signupMode = (process.env.SIGNUP_MODE ?? 'first').toLowerCase();
const production = process.env.NODE_ENV === 'production';

function defaultMailFrom(): string {
  try {
    return `Obelisk <no-reply@${new URL(publicUrl).hostname}>`;
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
   * Outgoing mail (password reset links), e.g. smtps://user:pass@smtp.resend.com:465 or smtp://user:pass@host:587.
   * Unset in production = "비밀번호 찾기" is hidden; unset in development = mails are printed to the server log.
   */
  smtpUrl: process.env.SMTP_URL?.trim() || null,
  mailFrom: process.env.MAIL_FROM?.trim() || defaultMailFrom(),
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
};

export const SESSION_COOKIE = 'obelisk_session';
