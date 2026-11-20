import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { AccountDeletionPreview, AdminAccountState, AdminUser, AdminUserFilter, AdminUserList } from '@obelisk/core';
import { and, desc, eq, ilike, isNotNull, isNull, or, sql, type SQL } from 'drizzle-orm';
import { AccountService } from '../auth/account.service';
import { actionMail, mailAvailable, sendMail } from '../common/mail';
import { config } from '../config';
import { InjectDb, type Db } from '../db/db.module';
import { apiTokens, oauthGrants, sessions, users, workspaceMembers, workspaces, type UserRow } from '../db/schema';
import { AdminLogService } from '../server/log.service';
import { avatarPath } from '../workspace/avatars.service';

/** Operator changes that touch who is an operator take this lock, so the last one can't be removed twice at once. */
const ADMINS_LOCK = 731_6002;

function stateOf(u: Pick<UserRow, 'suspendedAt' | 'mustVerifyEmail' | 'emailVerifiedAt' | 'pendingApprovalAt'>): AdminAccountState {
  if (u.suspendedAt) return 'suspended';
  if (u.mustVerifyEmail && !u.emailVerifiedAt) return 'unverified';
  if (u.pendingApprovalAt) return 'pending';
  return 'active';
}

const FILTER: Record<AdminUserFilter, SQL | undefined> = {
  all: undefined,
  pending: and(isNotNull(users.pendingApprovalAt), isNull(users.suspendedAt)),
  suspended: isNotNull(users.suspendedAt),
  admins: eq(users.admin, true),
  unverified: and(eq(users.mustVerifyEmail, true), isNull(users.emailVerifiedAt), isNull(users.suspendedAt)),
};

const likeEscape = (q: string) => q.replace(/[\\%_]/g, (c) => `\\${c}`);

/**
 * The outer row's id, spelled out: in a single-table select Drizzle writes a bare "id", which inside
 * these subqueries would name the subquery's own table instead.
 */
const UID = sql.raw('"users"."id"');
const orgsOf = sql<number>`(select count(*)::int from ${workspaceMembers} m join ${workspaces} w on w.id = m.workspace_id where m.user_id = ${UID} and w.kind = 'org')`;
const ownedOf = sql<number>`(select count(*)::int from ${workspaceMembers} m join ${workspaces} w on w.id = m.workspace_id where m.user_id = ${UID} and w.kind = 'org' and m.role = 'owner')`;
const tokensOf = sql<number>`(select count(*)::int from ${apiTokens} t where t.user_id = ${UID} and t.revoked_at is null)`;
const grantsOf = sql<number>`(select count(*)::int from ${oauthGrants} g where g.user_id = ${UID} and g.revoked_at is null and g.refresh_expires_at > now())`;

/**
 * 서버 관리 → 사용자. Operators see accounts (who, when, how many) and can let people in, stop them,
 * or remove them. Nothing here reads what anyone wrote.
 */
@Injectable()
export class AdminUsersService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly account: AccountService,
    private readonly log: AdminLogService,
  ) {}

  async list(input: { q?: string; filter?: AdminUserFilter; offset?: number; limit?: number }): Promise<AdminUserList> {
    const q = input.q?.trim();
    const search = q ? or(ilike(users.email, `%${likeEscape(q)}%`), ilike(users.name, `%${likeEscape(q)}%`)) : undefined;
    const where = and(search, FILTER[input.filter ?? 'all']);
    const [rows, [total], [counts]] = await Promise.all([
      this.db
        .select({ u: users, orgs: orgsOf, owned: ownedOf, tokens: tokensOf, grants: grantsOf })
        .from(users)
        .where(where)
        // Applications waiting on an operator come first; then the newest accounts.
        .orderBy(sql`${users.pendingApprovalAt} is null`, desc(users.createdAt))
        .offset(input.offset ?? 0)
        .limit(input.limit ?? 50),
      this.db.select({ n: sql<number>`count(*)::int` }).from(users).where(where),
      this.db
        .select({
          all: sql<number>`count(*)::int`,
          pending: sql<number>`(count(*) filter (where ${FILTER.pending}))::int`,
          suspended: sql<number>`(count(*) filter (where ${FILTER.suspended}))::int`,
          admins: sql<number>`(count(*) filter (where ${FILTER.admins}))::int`,
          unverified: sql<number>`(count(*) filter (where ${FILTER.unverified}))::int`,
        })
        .from(users)
        .where(search),
    ]);
    return {
      users: rows.map(({ u, orgs, owned, tokens, grants }) => this.view(u, { orgs, owned, tokens, grants })),
      total: total?.n ?? 0,
      counts: counts ?? { all: 0, pending: 0, suspended: 0, admins: 0, unverified: 0 },
    };
  }

  private view(u: UserRow, n: { orgs: number; owned: number; tokens: number; grants: number }): AdminUser {
    return {
      id: u.id,
      email: u.email,
      name: u.name,
      avatarUrl: avatarPath(u.avatarId),
      admin: u.admin,
      state: stateOf(u),
      emailVerified: !!u.emailVerifiedAt,
      createdAt: u.createdAt.toISOString(),
      lastSeenAt: u.lastSeenAt?.toISOString() ?? null,
      suspendedAt: u.suspendedAt?.toISOString() ?? null,
      pendingSince: u.pendingApprovalAt?.toISOString() ?? null,
      orgs: n.orgs,
      ownedOrgs: n.owned,
      apiTokens: n.tokens,
      aiConnections: n.grants,
    };
  }

  async one(id: string): Promise<AdminUser> {
    const list = await this.db
      .select({ u: users, orgs: orgsOf, owned: ownedOf, tokens: tokensOf, grants: grantsOf })
      .from(users)
      .where(eq(users.id, id));
    const r = list[0];
    if (!r) throw new NotFoundException('계정을 찾을 수 없어요');
    return this.view(r.u, r);
  }

  private async target(id: string): Promise<UserRow> {
    const u = await this.db.query.users.findFirst({ where: eq(users.id, id) });
    if (!u) throw new NotFoundException('계정을 찾을 수 없어요');
    return u;
  }

  private notSelf(actor: UserRow, u: UserRow, what: string) {
    if (actor.id === u.id) throw new BadRequestException(`자기 계정은 ${what}할 수 없어요`);
  }

  // ───────────────────────────── sign-up approval

  async approve(actor: UserRow, id: string): Promise<AdminUser> {
    const u = await this.target(id);
    if (!u.pendingApprovalAt) throw new BadRequestException('승인을 기다리는 계정이 아니에요');
    await this.db.transaction(async (tx) => {
      await tx.update(users).set({ pendingApprovalAt: null }).where(eq(users.id, u.id));
      await this.log.record(tx, actor, 'user.approved', u);
    });
    if (mailAvailable()) {
      void sendMail(
        actionMail({
          to: u.email,
          subject: 'Obelisk 가입이 승인됐어요',
          heading: '이제 Obelisk를 쓸 수 있어요',
          lines: [`${u.name}님, ${config.publicUrl}의 Obelisk 가입이 승인됐어요.`],
          action: 'Obelisk 열기',
          url: config.publicUrl,
          footer: '이 서버에 가입을 신청해서 받는 메일이에요.',
        }),
      ).catch((err) => console.error(`[mail] approval mail failed: ${(err as Error).message}`));
    }
    return this.one(u.id);
  }

  /** Turning an application down deletes the account it made (nothing else was in it yet). */
  async reject(actor: UserRow, id: string): Promise<void> {
    const u = await this.target(id);
    if (!u.pendingApprovalAt) throw new BadRequestException('승인을 기다리는 계정이 아니에요');
    await this.account.purge(u, { byOperator: true, inTx: (tx) => this.log.record(tx, actor, 'user.rejected', u) });
  }

  // ───────────────────────────── suspension

  /**
   * Stop an account: it can't sign in, its sessions end, its API tokens and AI connections are revoked
   * (new ones are needed after a lift) and incoming webhooks it made stop running. Data stays.
   */
  async suspend(actor: UserRow, id: string, note?: string): Promise<AdminUser> {
    const u = await this.target(id);
    this.notSelf(actor, u, '정지');
    if (u.admin) throw new BadRequestException('운영자는 정지할 수 없어요. 먼저 운영자에서 해제하세요.');
    if (u.suspendedAt) throw new BadRequestException('이미 정지된 계정이에요');
    await this.db.transaction(async (tx) => {
      await tx.update(users).set({ suspendedAt: new Date() }).where(eq(users.id, u.id));
      await tx.delete(sessions).where(eq(sessions.userId, u.id));
      await tx.update(apiTokens).set({ revokedAt: new Date() }).where(and(eq(apiTokens.userId, u.id), isNull(apiTokens.revokedAt)));
      await tx.update(oauthGrants).set({ revokedAt: new Date() }).where(and(eq(oauthGrants.userId, u.id), isNull(oauthGrants.revokedAt)));
      await this.log.record(tx, actor, 'user.suspended', u, note ? { note } : {});
    });
    return this.one(u.id);
  }

  async unsuspend(actor: UserRow, id: string): Promise<AdminUser> {
    const u = await this.target(id);
    if (!u.suspendedAt) throw new BadRequestException('정지된 계정이 아니에요');
    await this.db.transaction(async (tx) => {
      await tx.update(users).set({ suspendedAt: null }).where(eq(users.id, u.id));
      await this.log.record(tx, actor, 'user.unsuspended', u);
    });
    return this.one(u.id);
  }

  // ───────────────────────────── operators

  async setAdmin(actor: UserRow, id: string, admin: boolean): Promise<AdminUser> {
    const u = await this.target(id);
    if (u.admin === admin) return this.one(u.id);
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${ADMINS_LOCK})`);
      const fresh = await tx.query.users.findFirst({ where: eq(users.id, u.id) });
      if (!fresh) throw new NotFoundException('계정을 찾을 수 없어요');
      if (admin) {
        if (fresh.suspendedAt) throw new BadRequestException('정지된 계정은 운영자로 지정할 수 없어요');
        if (stateOf(fresh) !== 'active') throw new BadRequestException('가입이 끝난 계정만 운영자로 지정할 수 있어요');
      } else {
        const [n] = await tx.select({ n: sql<number>`count(*)::int` }).from(users).where(eq(users.admin, true));
        if ((n?.n ?? 0) <= 1) throw new BadRequestException('운영자는 최소 한 명 있어야 해요. 다른 계정을 먼저 운영자로 지정하세요.');
      }
      await tx.update(users).set({ admin }).where(eq(users.id, u.id));
      await this.log.record(tx, actor, admin ? 'admin.granted' : 'admin.revoked', u);
    });
    return this.one(u.id);
  }

  // ───────────────────────────── access recovery

  /**
   * A one-time link to set a new password, for someone locked out on a server without mail (or whose
   * mail never arrives). The operator hands it over; it works once, for an hour, and ends every session.
   */
  async resetLink(actor: UserRow, id: string, mail: boolean): Promise<{ url: string; mailed: boolean }> {
    const u = await this.target(id);
    if (u.suspendedAt) throw new BadRequestException('정지된 계정이에요. 정지를 먼저 푸세요.');
    if (mail && !mailAvailable()) throw new BadRequestException('이 서버는 메일을 보낼 수 없어요. 링크를 복사해 전해 주세요.');
    const url = await this.account.resetLink(u.id);
    await this.log.record(this.db, actor, 'user.reset_link', u, { mailed: mail });
    if (mail) await sendMail(this.account.resetMail(u, url, true));
    return { url, mailed: mail };
  }

  /** Let an account in without confirming its address (the mail never arrives). It stays "unconfirmed". */
  async skipVerification(actor: UserRow, id: string): Promise<AdminUser> {
    const u = await this.target(id);
    if (!u.mustVerifyEmail || u.emailVerifiedAt) throw new BadRequestException('메일 확인을 기다리는 계정이 아니에요');
    await this.db.transaction(async (tx) => {
      await tx.update(users).set({ mustVerifyEmail: false }).where(eq(users.id, u.id));
      await this.log.record(tx, actor, 'user.verification_skipped', u);
    });
    return this.one(u.id);
  }

  // ───────────────────────────── deletion

  async deletionPreview(id: string): Promise<AccountDeletionPreview> {
    const u = await this.target(id);
    return this.account.deletionPreview(u.id);
  }

  /** Same rules as deleting one's own account (refused while they are an organization's last owner). */
  async remove(actor: UserRow, id: string, confirm: string): Promise<void> {
    const u = await this.target(id);
    this.notSelf(actor, u, '여기서 삭제');
    if (u.admin) throw new ForbiddenException('운영자 계정은 삭제할 수 없어요. 먼저 운영자에서 해제하세요.');
    if (confirm.trim().toLowerCase() !== u.email.toLowerCase()) throw new BadRequestException('확인용 이메일이 일치하지 않아요');
    await this.account.purge(u, { byOperator: true, inTx: (tx) => this.log.record(tx, actor, 'user.deleted', u) });
  }
}
