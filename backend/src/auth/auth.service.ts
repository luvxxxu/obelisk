import { ConflictException, ForbiddenException, Injectable, UnauthorizedException, HttpException } from '@nestjs/common';
import { emailDomainAllowed, workHoursOf, type AccountGate, type HomeLayout, type SignupInput, type SignupStatus, type User, type WorkHours } from '@obelisk/core';
import { and, eq, gt, isNull, count, sql } from 'drizzle-orm';
import type { Request } from 'express';
import { config, SESSION_COOKIE } from '../config';
import { randomToken, sha256 } from '../common/crypto';
import { bearerToken, parseCookies } from '../common/http';
import { InjectDb, type Db } from '../db/db.module';
import { apiTokens, oauthGrants, sessions, users, workspaceMembers, workspaces, type UserRow } from '../db/schema';
import { jevStatus } from '../jev/status';
import { ReservationsService } from '../migration/reservations.service';
import { isServerInvite, ServerInvitesService } from '../server/invites.service';
import { AdminLogService } from '../server/log.service';
import { ServerSettingsService } from '../server/settings.service';
import type { Conn } from '../workspace/access.service';
import { avatarPath } from '../workspace/avatars.service';
import { WorkspacesService } from '../workspace/workspaces.service';
import { EmailService } from './email.service';

export interface AuthContext {
  user: UserRow;
  /** `webhook` = an incoming webhook acting as the person who made it (never reaches the guards). */
  via: 'session' | 'api_token' | 'oauth' | 'webhook';
  /** Session or token id, used e.g. for logout */
  credentialId: string;
  /** The OAuth app or API token name — shown in the activity log ("via Claude"). */
  client?: string | null;
}

export function toUser(r: UserRow): User {
  return {
    id: r.id,
    email: r.email,
    name: r.name,
    timezone: r.timezone,
    defaultWorkspaceId: r.defaultWorkspaceId,
    jev: jevStatus(r),
    homeLayout: r.homeLayout ?? null,
    avatarUrl: avatarPath(r.avatarId),
    admin: r.admin,
    emailVerified: !!r.emailVerifiedAt,
    workHours: workHoursOf(r.workHours),
    createdAt: r.createdAt.toISOString(),
  };
}

/** What keeps a signed-in account out of the app (suspension ends its sessions instead). */
export function gateOf(u: Pick<UserRow, 'mustVerifyEmail' | 'emailVerifiedAt' | 'pendingApprovalAt'>): AccountGate | null {
  if (u.mustVerifyEmail && !u.emailVerifiedAt) return 'email_unverified';
  if (u.pendingApprovalAt) return 'pending_approval';
  return null;
}


/** last_seen_at is written at most this often per account. */
const SEEN_EVERY_MS = 5 * 60_000;

const DUMMY_HASH = await Bun.password.hash('obelisk-timing-guard');
const attempts = new Map<string, { count: number; resetAt: number }>();

/** A successful password reset also lifts the login lockout for that address. */
export function clearLoginThrottle(email: string) {
  attempts.delete(email);
}

function throttle(key: string) {
  const nowMs = Date.now();
  const cur = attempts.get(key);
  if (!cur || cur.resetAt < nowMs) {
    attempts.set(key, { count: 1, resetAt: nowMs + 10 * 60_000 });
    return;
  }
  cur.count++;
  if (cur.count > 10) throw new HttpException('로그인 시도가 너무 많습니다. 잠시 후 다시 시도하세요.', 429);
}

@Injectable()
export class AuthService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly workspaces: WorkspacesService,
    private readonly reservations: ReservationsService,
    private readonly settings: ServerSettingsService,
    private readonly serverInvites: ServerInvitesService,
    private readonly adminLog: AdminLogService,
    private readonly email: EmailService,
  ) {}

  private async inviteWorks(token: string | undefined, conn: Conn = this.db): Promise<boolean> {
    if (!token) return false;
    return isServerInvite(token) ? this.serverInvites.usable(token, conn) : this.workspaces.inviteUsable(token, conn);
  }

  /** What the sign-up page needs to know before anyone types: can they, and what happens after. */
  async signupStatus(inviteToken?: string): Promise<SignupStatus> {
    const r = await this.settings.row();
    const mode = this.settings.signupMode(r);
    const [n] = await this.db.select({ n: count() }).from(users);
    const first = (n?.n ?? 0) === 0;
    const invited = await this.inviteWorks(inviteToken);
    const allowed = first || (mode !== 'closed' && (invited || mode === 'open' || mode === 'approval'));
    return {
      allowed,
      first,
      mode,
      invited,
      approval: !first && !invited && mode === 'approval',
      verifyEmail: !first && this.settings.verificationRequired(r, invited),
      domains: first || invited ? [] : r.allowedEmailDomains,
    };
  }

  async signupAllowed(inviteToken?: string): Promise<boolean> {
    return (await this.signupStatus(inviteToken)).allowed;
  }

  /**
   * New account + its personal space. With a live organization invite or claim link (obr_…),
   * sign-up is allowed whatever SIGNUP_MODE says, and the new account joins that organization
   * right away (it then opens there by default).
   */
  /**
   * New account + its personal space. The server's sign-up mode decides who may: the very first
   * account always (it becomes the operator), then open / approval / invite-only / closed. With a live
   * organization invite or claim link (obr_…) the new account joins that organization right away (it
   * then opens there by default); a server invite (osi_…) only lets the sign-up through. Invites skip
   * approval and the domain list.
   */
  async signup(input: SignupInput) {
    const passwordHash = await Bun.password.hash(input.password);
    const { user, joined, mustVerify, pending } = await this.db.transaction(async (tx) => {
      // Serialize sign-ups so two people can't both become "the first user".
      await tx.execute(sql`select pg_advisory_xact_lock(731_6001)`);
      const r = await this.settings.row(tx);
      const mode = this.settings.signupMode(r);
      const [n] = await tx.select({ n: count() }).from(users);
      const first = (n?.n ?? 0) === 0;

      const token = input.inviteToken;
      const serverInvite = isServerInvite(token);
      const orgInvite = !!token && !serverInvite && (await this.workspaces.inviteUsable(token, tx));
      if (token && !serverInvite && !orgInvite) throw new ForbiddenException('초대 링크가 만료되었거나 더 이상 쓸 수 없습니다');
      const invited = serverInvite || orgInvite;

      if (!first) {
        if (mode === 'closed') throw new ForbiddenException('이 서버는 새 계정 가입을 받지 않습니다');
        if (mode === 'invite' && !invited) throw new ForbiddenException('이 서버는 초대 링크로만 가입할 수 있어요');
        if (!invited && !emailDomainAllowed(input.email, r.allowedEmailDomains)) {
          throw new ForbiddenException(`이 서버는 ${r.allowedEmailDomains.map((d) => `@${d}`).join(', ')} 주소로만 가입할 수 있어요`);
        }
      }
      const existing = await tx.query.users.findFirst({ where: eq(users.email, input.email) });
      if (existing) throw new ConflictException('이미 가입된 이메일입니다');
      if (serverInvite) await this.serverInvites.consume(tx, token);

      const mustVerify = !first && this.settings.verificationRequired(r, invited);
      const pending = !first && !invited && mode === 'approval';
      const [created] = await tx
        .insert(users)
        .values({
          email: input.email,
          name: input.name,
          passwordHash,
          timezone: input.timezone ?? 'Asia/Seoul',
          admin: first,
          mustVerifyEmail: mustVerify,
          pendingApprovalAt: pending ? new Date() : null,
        })
        .returning();
      const [personal] = await tx
        .insert(workspaces)
        .values({ kind: 'personal', name: '개인 공간', personalUserId: created!.id })
        .returning();
      await tx.insert(workspaceMembers).values({ workspaceId: personal!.id, userId: created!.id, role: 'owner' });
      let joined: string | null = null;
      if (orgInvite) {
        joined = await this.workspaces.acceptInvite({ user: created!, via: 'session', credentialId: '' }, token!, tx);
      }
      // A place reserved for this email in an imported organization is only noted for its admins: the
      // address isn't verified yet, so the account gets in with the claim link, or by confirming the
      // address later. (After the invite or claim above, so the workspace lock is always taken before
      // reservation rows.)
      await this.reservations.matchEmail(tx, created!);
      if (first) await this.adminLog.record(tx, created!, 'admin.first', created!);
      const [user] = await tx
        .update(users)
        .set({ defaultWorkspaceId: joined ?? personal!.id })
        .where(eq(users.id, created!.id))
        .returning();
      return { user: user!, joined, mustVerify, pending };
    });
    if (mustVerify) void this.email.sendVerification(user).catch((err) => console.error(`[mail] verification mail failed: ${(err as Error).message}`));
    else if (pending) void this.settings.notifyPending(user).catch(() => {});
    const token = await this.createSession(user.id);
    return { user, token, joinedWorkspaceId: joined };
  }

  async login(email: string, password: string) {
    throttle(email);
    const user = await this.db.query.users.findFirst({ where: eq(users.email, email) });
    const ok = await Bun.password.verify(password, user?.passwordHash ?? DUMMY_HASH);
    if (!user || !ok) throw new UnauthorizedException('이메일 또는 비밀번호가 올바르지 않습니다');
    // Only told after the right password, so the message can't be used to probe which addresses exist.
    if (user.suspendedAt) throw new ForbiddenException('이 계정은 정지됐어요. 서버 운영자에게 문의하세요.');
    attempts.delete(email);
    const token = await this.createSession(user.id);
    return { user, token };
  }

  async verifyPassword(userId: string, password: string): Promise<boolean> {
    const user = await this.db.query.users.findFirst({ where: eq(users.id, userId) });
    return !!user && (await Bun.password.verify(password, user.passwordHash));
  }

  async createSession(userId: string): Promise<string> {
    const token = randomToken('obs');
    await this.db.insert(sessions).values({
      id: sha256(token),
      userId,
      expiresAt: new Date(Date.now() + config.sessionDays * 86_400_000),
    });
    return token;
  }

  async destroySession(token: string) {
    await this.db.delete(sessions).where(eq(sessions.id, sha256(token)));
  }

  sessionTokenFrom(req: Request): string | null {
    return parseCookies(req.headers.cookie)[SESSION_COOKIE] ?? null;
  }

  async updateMe(
    userId: string,
    patch: { name?: string; timezone?: string; defaultWorkspaceId?: string; homeLayout?: HomeLayout | null; workHours?: WorkHours },
  ) {
    if (patch.defaultWorkspaceId) {
      const member = await this.db.query.workspaceMembers.findFirst({
        where: and(eq(workspaceMembers.workspaceId, patch.defaultWorkspaceId), eq(workspaceMembers.userId, userId)),
      });
      if (!member) throw new ForbiddenException('멤버인 공간만 기본 공간으로 고를 수 있습니다');
    }
    const [row] = await this.db.update(users).set(patch).where(eq(users.id, userId)).returning();
    return row!;
  }

  /** Resolve whoever is calling: web session cookie, personal API token, or OAuth access token. */
  async authenticate(req: Request): Promise<AuthContext | null> {
    const bearer = bearerToken(req);
    if (bearer) return this.authenticateBearer(bearer);

    const token = this.sessionTokenFrom(req);
    if (!token) return null;
    const row = await this.db
      .select({ user: users, sessionId: sessions.id })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(and(eq(sessions.id, sha256(token)), gt(sessions.expiresAt, new Date())))
      .limit(1);
    if (!row[0] || row[0].user.suspendedAt) return null;
    this.seen(row[0].user);
    return { user: row[0].user, via: 'session', credentialId: row[0].sessionId };
  }

  /** Marks the account as active now (for 서버 관리), at most every few minutes and off the request's path. */
  private seen(user: UserRow) {
    if (user.lastSeenAt && Date.now() - user.lastSeenAt.getTime() < SEEN_EVERY_MS) return;
    user.lastSeenAt = new Date();
    void this.db
      .update(users)
      .set({ lastSeenAt: sql`now()` })
      .where(eq(users.id, user.id))
      .catch(() => {});
  }

  /** API tokens and AI apps work only for accounts that are fully in (not suspended, confirmed, approved). */
  private bearerOk(user: UserRow): boolean {
    if (user.suspendedAt || gateOf(user)) return false;
    this.seen(user);
    return true;
  }

  async authenticateBearer(token: string): Promise<AuthContext | null> {
    const hash = sha256(token);
    if (token.startsWith('obk_')) {
      const rows = await this.db
        .select({ user: users, id: apiTokens.id, name: apiTokens.name, lastUsedAt: apiTokens.lastUsedAt })
        .from(apiTokens)
        .innerJoin(users, eq(users.id, apiTokens.userId))
        .where(and(eq(apiTokens.tokenHash, hash), isNull(apiTokens.revokedAt)))
        .limit(1);
      const hit = rows[0];
      if (!hit || !this.bearerOk(hit.user)) return null;
      if (!hit.lastUsedAt || Date.now() - hit.lastUsedAt.getTime() > 60_000) {
        await this.db.update(apiTokens).set({ lastUsedAt: sql`now()` }).where(eq(apiTokens.id, hit.id));
      }
      return { user: hit.user, via: 'api_token', credentialId: hit.id, client: hit.name };
    }
    if (token.startsWith('oat_')) {
      const rows = await this.db
        .select({ user: users, id: oauthGrants.id, clientName: oauthGrants.clientName, lastUsedAt: oauthGrants.lastUsedAt })
        .from(oauthGrants)
        .innerJoin(users, eq(users.id, oauthGrants.userId))
        .where(
          and(
            eq(oauthGrants.accessHash, hash),
            isNull(oauthGrants.revokedAt),
            gt(oauthGrants.accessExpiresAt, new Date()),
          ),
        )
        .limit(1);
      const hit = rows[0];
      if (!hit || !this.bearerOk(hit.user)) return null;
      if (!hit.lastUsedAt || Date.now() - hit.lastUsedAt.getTime() > 60_000) {
        await this.db.update(oauthGrants).set({ lastUsedAt: sql`now()` }).where(eq(oauthGrants.id, hit.id));
      }
      return { user: hit.user, via: 'oauth', credentialId: hit.id, client: hit.clientName };
    }
    return null;
  }
}
