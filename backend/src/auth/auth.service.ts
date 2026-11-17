import { ConflictException, ForbiddenException, Injectable, UnauthorizedException, HttpException } from '@nestjs/common';
import type { HomeLayout, SignupInput, User } from '@obelisk/core';
import { and, eq, gt, isNull, count, sql } from 'drizzle-orm';
import type { Request } from 'express';
import { config, SESSION_COOKIE } from '../config';
import { randomToken, sha256 } from '../common/crypto';
import { bearerToken, parseCookies } from '../common/http';
import { InjectDb, type Db } from '../db/db.module';
import { apiTokens, oauthGrants, sessions, users, workspaceMembers, workspaces, type UserRow } from '../db/schema';
import { jevStatus } from '../jev/status';
import { WorkspacesService } from '../workspace/workspaces.service';

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
    createdAt: r.createdAt.toISOString(),
  };
}

const DUMMY_HASH = await Bun.password.hash('obelisk-timing-guard');
const attempts = new Map<string, { count: number; resetAt: number }>();

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
  ) {}

  async signupAllowed(inviteToken?: string): Promise<boolean> {
    if (config.signupMode === 'open') return true;
    if (inviteToken && (await this.workspaces.inviteUsable(inviteToken))) return true;
    if (config.signupMode === 'closed') return false;
    const [row] = await this.db.select({ n: count() }).from(users);
    return (row?.n ?? 0) === 0;
  }

  /**
   * New account + its personal space. With a live organization invite, sign-up is allowed
   * whatever SIGNUP_MODE says, and the new account joins that organization right away
   * (it then opens there by default).
   */
  async signup(input: SignupInput) {
    const passwordHash = await Bun.password.hash(input.password);
    const { user, joined } = await this.db.transaction(async (tx) => {
      // Serialize sign-ups so two people can't both become "the first user".
      await tx.execute(sql`select pg_advisory_xact_lock(731_6001)`);
      const invited = !!input.inviteToken && (await this.workspaces.inviteUsable(input.inviteToken, tx));
      if (input.inviteToken && !invited) throw new ForbiddenException('초대 링크가 만료되었거나 더 이상 쓸 수 없습니다');
      if (!invited && config.signupMode === 'closed') throw new ForbiddenException('이 서버는 새 계정 가입을 받지 않습니다');
      if (!invited && config.signupMode === 'first') {
        const [row] = await tx.select({ n: count() }).from(users);
        if ((row?.n ?? 0) > 0) throw new ForbiddenException('이 서버는 새 계정 가입을 받지 않습니다');
      }
      const existing = await tx.query.users.findFirst({ where: eq(users.email, input.email) });
      if (existing) throw new ConflictException('이미 가입된 이메일입니다');
      const [created] = await tx
        .insert(users)
        .values({ email: input.email, name: input.name, passwordHash, timezone: input.timezone ?? 'Asia/Seoul' })
        .returning();
      const [personal] = await tx
        .insert(workspaces)
        .values({ kind: 'personal', name: '개인 공간', personalUserId: created!.id })
        .returning();
      await tx.insert(workspaceMembers).values({ workspaceId: personal!.id, userId: created!.id, role: 'owner' });
      let joined: string | null = null;
      if (invited) {
        joined = await this.workspaces.acceptInvite({ user: created!, via: 'session', credentialId: '' }, input.inviteToken!, tx);
      }
      const [user] = await tx
        .update(users)
        .set({ defaultWorkspaceId: joined ?? personal!.id })
        .where(eq(users.id, created!.id))
        .returning();
      return { user: user!, joined };
    });
    const token = await this.createSession(user.id);
    return { user, token, joinedWorkspaceId: joined };
  }

  async login(email: string, password: string) {
    throttle(email);
    const user = await this.db.query.users.findFirst({ where: eq(users.email, email) });
    const ok = await Bun.password.verify(password, user?.passwordHash ?? DUMMY_HASH);
    if (!user || !ok) throw new UnauthorizedException('이메일 또는 비밀번호가 올바르지 않습니다');
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
    patch: { name?: string; timezone?: string; defaultWorkspaceId?: string; homeLayout?: HomeLayout | null },
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
    if (!row[0]) return null;
    return { user: row[0].user, via: 'session', credentialId: row[0].sessionId };
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
      if (!hit) return null;
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
      if (!hit) return null;
      if (!hit.lastUsedAt || Date.now() - hit.lastUsedAt.getTime() > 60_000) {
        await this.db.update(oauthGrants).set({ lastUsedAt: sql`now()` }).where(eq(oauthGrants.id, hit.id));
      }
      return { user: hit.user, via: 'oauth', credentialId: hit.id, client: hit.clientName };
    }
    return null;
  }
}
