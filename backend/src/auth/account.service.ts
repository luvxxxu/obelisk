import { BadRequestException, ConflictException, HttpException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import type { AccountDeletionPreview } from '@obelisk/core';
import { and, count, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm';
import { config } from '../config';
import { randomToken, sha256 } from '../common/crypto';
import { actionMail, mailAvailable, sendMail } from '../common/mail';
import { rateLimiter } from '../common/rate-limit';
import { InjectDb, type Db } from '../db/db.module';
import { passwordResets, projects, sessions, tasks, users, workspaceMembers, workspaces, type UserRow } from '../db/schema';
import type { Conn } from '../workspace/access.service';
import { AccessService } from '../workspace/access.service';
import { ActivityService } from '../workspace/activity.service';
import { AuthService, clearLoginThrottle, type AuthContext } from './auth.service';

const resetIpLimit = rateLimiter(10, 15 * 60_000);
/** Per address: a few mails an hour, then requests are quietly dropped (no hint whether the account exists). */
const resetEmailLimit = rateLimiter(3, 60 * 60_000);
const tokenIpLimit = rateLimiter(30, 15 * 60_000);
const deleteLimit = rateLimiter(5, 15 * 60_000);

function hit(limit: (key: string) => void, key: string): boolean {
  try {
    limit(key);
    return false;
  } catch {
    return true;
  }
}

const tooMany = () => new HttpException('요청이 너무 많아요. 잠시 후 다시 시도하세요.', 429);

interface OrgMembership {
  id: string;
  name: string;
  role: string;
  members: number;
  owners: number;
}

@Injectable()
export class AccountService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly auth: AuthService,
    private readonly access: AccessService,
    private readonly activity: ActivityService,
  ) {}

  // ───────────────────────────── password reset by mail

  passwordResetAvailable(): boolean {
    return mailAvailable();
  }

  /**
   * Mails a one-time link if the address has an account. The answer is the same either way,
   * and the mail goes out after the response so timing doesn't tell either.
   */
  async requestPasswordReset(email: string, ip: string): Promise<void> {
    if (!mailAvailable()) throw new NotFoundException('이 서버는 메일을 보낼 수 없어요. 관리자에게 비밀번호 초기화를 요청하세요.');
    if (hit(resetIpLimit, ip)) throw tooMany();
    if (hit(resetEmailLimit, email)) return;
    const user = await this.db.query.users.findFirst({ where: eq(users.email, email) });
    // A suspended account couldn't sign in with a new password anyway.
    if (!user || user.suspendedAt) return;
    const url = await this.resetLink(user.id);
    void sendMail(this.resetMail(user, url)).catch((err) => console.error(`[mail] password reset mail failed: ${(err as Error).message}`));
  }

  /** A fresh one-time reset link (sent by mail, or handed over by an operator). */
  async resetLink(userId: string): Promise<string> {
    const token = randomToken('opr');
    await this.db.insert(passwordResets).values({
      id: sha256(token),
      userId,
      expiresAt: new Date(Date.now() + config.passwordResetMinutes * 60_000),
    });
    return `${config.publicUrl}/reset-password#${token}`;
  }

  resetMail(user: Pick<UserRow, 'email' | 'name'>, url: string, byOperator = false) {
    return actionMail({
      to: user.email,
      subject: 'Obelisk 비밀번호 재설정',
      heading: '비밀번호를 다시 설정하세요',
      lines: [
        byOperator
          ? `${user.name}님, 서버 운영자가 Obelisk 계정(${user.email})의 비밀번호 재설정 링크를 보냈어요.`
          : `${user.name}님, Obelisk 계정(${user.email})의 비밀번호 재설정을 요청받았어요.`,
        `아래 버튼을 눌러 새 비밀번호를 정하세요. 링크는 ${config.passwordResetMinutes}분 동안 한 번만 쓸 수 있어요.`,
      ],
      action: '새 비밀번호 정하기',
      url,
      footer: '요청한 적이 없다면 이 메일은 무시하세요. 비밀번호는 바뀌지 않아요.',
    });
  }

  private async liveReset(token: string, conn: Conn = this.db) {
    const [row] = await conn
      .select({ reset: passwordResets, user: users })
      .from(passwordResets)
      .innerJoin(users, eq(users.id, passwordResets.userId))
      .where(and(eq(passwordResets.id, sha256(token)), isNull(passwordResets.usedAt), gt(passwordResets.expiresAt, new Date())))
      .limit(1);
    return row ?? null;
  }

  /** Lets the reset page say "this link has expired" before anyone types a new password. */
  async checkPasswordReset(token: string, ip: string): Promise<{ valid: boolean; email: string | null }> {
    if (hit(tokenIpLimit, ip)) throw tooMany();
    const row = await this.liveReset(token);
    return { valid: !!row, email: row?.user.email ?? null };
  }

  /** New password, every other link and session for the account ends, and this browser signs in. */
  async resetPassword(token: string, password: string, ip: string): Promise<{ user: UserRow; session: string }> {
    if (hit(tokenIpLimit, ip)) throw tooMany();
    const passwordHash = await Bun.password.hash(password);
    const user = await this.db.transaction(async (tx) => {
      // Lock the link so two tabs can't both use it.
      await tx.execute(sql`select 1 from ${passwordResets} where ${passwordResets.id} = ${sha256(token)} for update`);
      const row = await this.liveReset(token, tx);
      if (!row) throw new BadRequestException('링크가 만료되었거나 이미 사용되었어요. 비밀번호 찾기를 다시 요청하세요.');
      if (row.user.suspendedAt) throw new BadRequestException('정지된 계정이라 비밀번호를 바꿀 수 없어요. 서버 운영자에게 문의하세요.');
      const [updated] = await tx.update(users).set({ passwordHash }).where(eq(users.id, row.user.id)).returning();
      await tx
        .update(passwordResets)
        .set({ usedAt: new Date() })
        .where(and(eq(passwordResets.userId, row.user.id), isNull(passwordResets.usedAt)));
      await tx.delete(sessions).where(eq(sessions.userId, row.user.id));
      return updated!;
    });
    clearLoginThrottle(user.email);
    const session = await this.auth.createSession(user.id);
    return { user, session };
  }

  // ───────────────────────────── account deletion

  private async orgMemberships(userId: string, conn: Conn = this.db): Promise<OrgMembership[]> {
    const members = sql<number>`(select count(*)::int from ${workspaceMembers} m where m.workspace_id = ${workspaces.id})`;
    const owners = sql<number>`(select count(*)::int from ${workspaceMembers} m where m.workspace_id = ${workspaces.id} and m.role = 'owner')`;
    return conn
      .select({ id: workspaces.id, name: workspaces.name, role: workspaceMembers.role, members, owners })
      .from(workspaceMembers)
      .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
      .where(and(eq(workspaceMembers.userId, userId), eq(workspaces.kind, 'org')))
      .orderBy(workspaceMembers.createdAt);
  }

  private static split(orgs: OrgMembership[]) {
    const solo = orgs.filter((o) => o.members <= 1);
    const blockers = orgs.filter((o) => o.members > 1 && o.role === 'owner' && o.owners <= 1);
    const shared = orgs.filter((o) => o.members > 1 && !blockers.includes(o));
    return { solo, blockers, shared };
  }

  async deletionPreview(userId: string): Promise<AccountDeletionPreview> {
    const personalId = await this.access.personalId(userId);
    const [orgs, [p], [t]] = await Promise.all([
      this.orgMemberships(userId),
      this.db.select({ n: count() }).from(projects).where(eq(projects.workspaceId, personalId)),
      this.db.select({ n: count() }).from(tasks).where(eq(tasks.workspaceId, personalId)),
    ]);
    const { solo, blockers, shared } = AccountService.split(orgs);
    return {
      blockers: blockers.map((o) => ({ id: o.id, name: o.name, memberCount: o.members })),
      soloOrgs: solo.map((o) => ({ id: o.id, name: o.name })),
      personal: { projects: p?.n ?? 0, tasks: t?.n ?? 0 },
      sharedOrgs: shared.length,
    };
  }

  /**
   * Deletes the account for good: the personal space, organizations nobody else is in, every credential.
   * In shared organizations the person leaves (their tasks stay, unassigned; the log keeps their name).
   * Refused while they are the last owner of an organization other people are still in.
   */
  async deleteAccount(auth: AuthContext, password: string): Promise<void> {
    const userId = auth.user.id;
    if (hit(deleteLimit, userId)) throw tooMany();
    if (!(await this.auth.verifyPassword(userId, password))) throw new UnauthorizedException('비밀번호가 올바르지 않아요');
    await this.purge(auth.user);
  }

  /**
   * The deletion itself, for the account's own request or an operator's. `inTx` runs inside the same
   * transaction (the operator log line), so the account and the record of deleting it go together.
   */
  async purge(user: UserRow, opts: { byOperator?: boolean; inTx?: (tx: Conn) => Promise<void> } = {}): Promise<void> {
    const userId = user.id;
    const auth: AuthContext = { user, via: 'session', credentialId: '' };
    await this.db.transaction(async (tx) => {
      const before = await this.orgMemberships(userId, tx);
      // Same lock as member/role changes, in a fixed order, so nobody is promoted or removed mid-way.
      for (const id of before.map((o) => o.id).sort()) {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${id}))`);
      }
      const { solo, blockers, shared } = AccountService.split(await this.orgMemberships(userId, tx));
      if (blockers.length) {
        throw new ConflictException(
          `${blockers.map((o) => `‘${o.name}’`).join(', ')}의 마지막 소유자예요. 다른 멤버를 소유자로 지정하거나 조직을 삭제한 뒤 다시 시도하세요.`,
        );
      }
      for (const o of shared) {
        const a = await this.access.forWorkspace(auth, o.id, tx);
        await this.activity.record(tx, a, {
          action: 'member.left',
          subject: user.name,
          data: { userId, accountDeleted: true, ...(opts.byOperator ? { byOperator: true } : {}) },
        });
      }
      // Spaces go first: if the user row's cascade reached them, Postgres would also try to blank
      // created_by / assignee on rows it is deleting in the same statement and trip the workspace FK.
      await tx
        .delete(workspaces)
        .where(or(eq(workspaces.personalUserId, userId), solo.length ? inArray(workspaces.id, solo.map((o) => o.id)) : undefined));
      // Everything else hangs off the user row: memberships, grants, sessions, tokens, incoming
      // webhooks and reset links cascade; authorship and assignments in shared orgs become empty.
      await tx.delete(users).where(eq(users.id, userId));
      await opts.inTx?.(tx);
    });
  }
}
