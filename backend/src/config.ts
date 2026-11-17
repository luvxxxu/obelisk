import { resolve } from 'node:path';

const publicUrl = (process.env.PUBLIC_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
const signupMode = (process.env.SIGNUP_MODE ?? 'first').toLowerCase();

export const config = {
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
};

export const SESSION_COOKIE = 'obelisk_session';
