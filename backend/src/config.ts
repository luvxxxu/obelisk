import { TRASH_DAYS } from '@obelisk/core';
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
  /**
   * The sign-up mode until an operator picks one in 서버 관리 (that choice is kept in the database).
   * first (default) and closed = only with an invite link once the first account exists (closed kept its
   * old meaning: invite links still work); open = anyone; approval = anyone may apply, an operator lets
   * them in; invite = only with an invite link. The very first account can always sign up.
   */
  signupMode: (signupMode === 'open' || signupMode === 'approval' ? signupMode : 'invite') as 'open' | 'approval' | 'invite',
  /** SIGNUP_MODE as written, for the config check. */
  signupModeRaw: process.env.SIGNUP_MODE?.trim() || null,
  /** Where the compose file's `backup` service writes pg_dump files (mounted read-only into backend). */
  backupDir: process.env.BACKUP_DIR?.trim() || '/backups',
  backupKeepDays: process.env.BACKUP_KEEP_DAYS ? Number(process.env.BACKUP_KEEP_DAYS) || null : null,
  /** Public repository the update check compares this build with ("owner/name"). */
  updateRepo: process.env.UPDATE_REPO?.trim() || 'luvxxxu/obelisk',
  updateBranch: process.env.UPDATE_BRANCH?.trim() || 'main',
  /** ADMIN_CLAIM=true: log a one-time operator link at start even though operators exist (lost access). */
  adminClaimForce: process.env.ADMIN_CLAIM === 'true',
  secureCookies: publicUrl.startsWith('https://'),
  sessionDays: 30,
  /** Deleted tasks wait in the trash (휴지통) this long before the hourly sweep removes them. */
  trashDays: TRASH_DAYS,
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
  /** Links that confirm an address (sign-up, email change) work this long. */
  emailTokenHours: 24,
  /** One-time operator link logged at start while the server has no operator. */
  adminClaimHours: 24,
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
