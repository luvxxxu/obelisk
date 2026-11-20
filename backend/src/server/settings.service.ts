import { BadRequestException, Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import type { Announcement, ServerInfo, ServerSettings, SignupMode, UpdateServerSettingsInput } from '@obelisk/core';
import { count, eq, sql } from 'drizzle-orm';
import { randomToken, sha256 } from '../common/crypto';
import { actionMail, mailAvailable, sendMail } from '../common/mail';
import { config } from '../config';
import { InjectDb, type Db } from '../db/db.module';
import { serverSettings, users, type ServerSettingsRow, type UserRow } from '../db/schema';
import type { Conn } from '../workspace/access.service';
import { AdminLogService, type LogActor } from './log.service';

/** Settings are read on every sign-up and bootstrap; a short cache keeps that to one query a minute at most. */
const CACHE_MS = 30_000;

const log = (m: string) => console.log(`[obelisk] ${m}`);

/**
 * The server's own settings (one row). Operators change them in 서버 관리; SIGNUP_MODE from the
 * environment is only the starting sign-up mode.
 */
@Injectable()
export class ServerSettingsService implements OnApplicationBootstrap {
  private cached: { row: ServerSettingsRow; at: number } | null = null;

  constructor(
    @InjectDb() private readonly db: Db,
    private readonly log: AdminLogService,
  ) {}

  /** The row, created with defaults on first use. Pass a transaction to read it fresh (and lock with `forUpdate`). */
  async row(conn?: Conn, opts: { forUpdate?: boolean } = {}): Promise<ServerSettingsRow> {
    if (!conn && this.cached && Date.now() - this.cached.at < CACHE_MS) return this.cached.row;
    const c = conn ?? this.db;
    const read = async () => {
      const q = c.select().from(serverSettings).where(eq(serverSettings.id, 1));
      return (opts.forUpdate ? await q.for('update') : await q)[0];
    };
    let row = await read();
    if (!row) {
      await c.insert(serverSettings).values({ id: 1 }).onConflictDoNothing();
      row = await read();
    }
    if (!conn) this.cached = { row: row!, at: Date.now() };
    return row!;
  }

  private forget() {
    this.cached = null;
  }

  signupMode(r: ServerSettingsRow): SignupMode {
    return r.signupMode ?? config.signupMode;
  }

  /**
   * Must a new account confirm its address before using the app? Only when the server can send mail.
   * An allowed-domain list needs the proof too, for sign-ups it applies to (those without an invite).
   */
  verificationRequired(r: ServerSettingsRow, invited: boolean): boolean {
    if (!mailAvailable()) return false;
    return r.requireEmailVerification || (!invited && r.allowedEmailDomains.length > 0);
  }

  announcement(r: ServerSettingsRow): Announcement | null {
    return r.announcementText && r.announcementAt ? { text: r.announcementText, at: r.announcementAt.toISOString() } : null;
  }

  canCreateOrg(r: ServerSettingsRow, user: Pick<UserRow, 'admin'>): boolean {
    return r.orgCreation === 'everyone' || user.admin;
  }

  async info(user: UserRow): Promise<ServerInfo> {
    const r = await this.row();
    return { announcement: this.announcement(r), canCreateOrg: this.canCreateOrg(r, user) };
  }

  view(r: ServerSettingsRow): ServerSettings {
    return {
      signupMode: this.signupMode(r),
      envSignupMode: config.signupMode,
      signupModeFromEnv: r.signupMode === null,
      requireEmailVerification: r.requireEmailVerification,
      allowedEmailDomains: r.allowedEmailDomains,
      orgCreation: r.orgCreation,
      updateCheck: r.updateCheck,
      announcement: this.announcement(r),
      mailAvailable: mailAvailable(),
      mailToLog: mailAvailable() && !config.smtpUrl,
    };
  }

  async settings(): Promise<ServerSettings> {
    return this.view(await this.row());
  }

  async update(actor: LogActor, input: UpdateServerSettingsInput): Promise<ServerSettings> {
    const domains = input.allowedEmailDomains ? [...new Set(input.allowedEmailDomains)] : undefined;
    // A confirmed address needs mail: refuse to turn on what can't work rather than lock every new account out.
    const turningOnProof = input.requireEmailVerification === true || (domains && domains.length > 0);
    if (turningOnProof && !mailAvailable()) {
      throw new BadRequestException('메일을 보낼 수 없는 서버라서 켤 수 없어요. SMTP_URL을 먼저 설정하세요.');
    }
    await this.db.transaction(async (tx) => {
      const cur = await this.row(tx, { forUpdate: true });
      const next = {
        signupMode: input.signupMode ?? cur.signupMode,
        requireEmailVerification: input.requireEmailVerification ?? cur.requireEmailVerification,
        allowedEmailDomains: domains ?? cur.allowedEmailDomains,
        orgCreation: input.orgCreation ?? cur.orgCreation,
        updateCheck: input.updateCheck ?? cur.updateCheck,
      };
      const changes: Record<string, { from: unknown; to: unknown }> = {};
      for (const k of Object.keys(next) as (keyof typeof next)[]) {
        const from = k === 'signupMode' ? this.signupMode(cur) : cur[k];
        const to = next[k];
        if (JSON.stringify(from) !== JSON.stringify(to)) changes[k] = { from, to };
      }
      if (!Object.keys(changes).length) return;
      await tx.update(serverSettings).set({ ...next, updatedAt: new Date() }).where(eq(serverSettings.id, 1));
      await this.log.record(tx, actor, 'settings.updated', null, { changes });
    });
    this.forget();
    return this.settings();
  }

  async setAnnouncement(actor: LogActor, text: string): Promise<ServerSettings> {
    const clean = text.trim();
    await this.db.transaction(async (tx) => {
      const cur = await this.row(tx, { forUpdate: true });
      if ((cur.announcementText ?? '') === clean) return;
      await tx
        .update(serverSettings)
        .set({ announcementText: clean || null, announcementAt: clean ? new Date() : null, updatedAt: new Date() })
        .where(eq(serverSettings.id, 1));
      await this.log.record(tx, actor, clean ? 'announcement.set' : 'announcement.cleared', null, clean ? { text: clean } : {});
    });
    this.forget();
    return this.settings();
  }

  // ───────────────────────────── the first operator

  /**
   * At start: a server with accounts but no operator (one that ran before 서버 관리 existed, or whose
   * operators all left) logs a one-time link. Whoever opens it signed in becomes an operator. The link
   * only ever appears in the server's own log, which only whoever runs the server can read.
   */
  async onApplicationBootstrap() {
    try {
      const [n] = await this.db
        .select({ users: count(), admins: sql<number>`count(*) filter (where ${users.admin})::int` })
        .from(users);
      if (!n?.users) {
        log('No accounts yet: the first account to sign up becomes this server\'s operator (서버 관리).');
        return;
      }
      if (n.admins > 0 && !config.adminClaimForce) {
        await this.db
          .update(serverSettings)
          .set({ adminClaimHash: null, adminClaimExpiresAt: null })
          .where(eq(serverSettings.id, 1));
        return;
      }
      await this.row();
      const token = randomToken('oac', 24);
      await this.db
        .update(serverSettings)
        .set({ adminClaimHash: sha256(token), adminClaimExpiresAt: new Date(Date.now() + config.adminClaimHours * 3_600_000) })
        .where(eq(serverSettings.id, 1));
      this.forget();
      log(
        `${n.admins > 0 ? 'ADMIN_CLAIM=true' : 'This server has no operator yet'}: sign in with the account that should run it, ` +
          `then open this one-time link within ${config.adminClaimHours}h (restarting makes a new one):\n` +
          `[obelisk]   ${config.publicUrl}/claim-admin#${token}`,
      );
    } catch (err) {
      console.error('[obelisk] could not prepare the operator link', err);
    }
  }

  /** Spend the logged link: the signed-in account becomes an operator. */
  async claim(user: UserRow, token: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const cur = await this.row(tx, { forUpdate: true });
      const live = cur.adminClaimHash && cur.adminClaimExpiresAt && cur.adminClaimExpiresAt > new Date();
      if (!live || cur.adminClaimHash !== sha256(token.trim())) {
        throw new BadRequestException('링크가 만료됐거나 이미 쓰였어요. 백엔드를 다시 시작하면 서버 로그에 새 링크가 나와요.');
      }
      await tx.update(serverSettings).set({ adminClaimHash: null, adminClaimExpiresAt: null }).where(eq(serverSettings.id, 1));
      await tx.update(users).set({ admin: true }).where(eq(users.id, user.id));
      await this.log.record(tx, user, 'admin.claimed', user);
    });
    this.forget();
  }

  // ───────────────────────────── telling operators

  /** A new application waits for approval: tell every operator who has an address we can mail. */
  async notifyPending(applicant: UserRow): Promise<void> {
    if (!mailAvailable()) return;
    const ops = await this.db
      .select({ email: users.email, name: users.name })
      .from(users)
      .where(sql`${users.admin} and ${users.suspendedAt} is null`);
    for (const op of ops) {
      const mail = actionMail({
        to: op.email,
        subject: `Obelisk 가입 신청: ${applicant.name}`,
        heading: '가입 신청이 들어왔어요',
        lines: [
          `${applicant.name}(${applicant.email})님이 이 서버에 가입을 신청했어요.`,
          '서버 관리 → 사용자에서 승인하거나 거절할 수 있어요.',
        ],
        action: '가입 신청 보기',
        url: `${config.publicUrl}/admin/users?filter=pending`,
        footer: '이 서버의 운영자라서 받는 메일이에요.',
      });
      void sendMail(mail).catch((err) => console.error(`[mail] pending sign-up mail failed: ${(err as Error).message}`));
    }
  }
}
