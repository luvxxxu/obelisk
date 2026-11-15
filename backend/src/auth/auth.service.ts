import { ConflictException, ForbiddenException, Injectable, UnauthorizedException, HttpException } from '@nestjs/common';
import type { SignupInput, User } from '@obelisk/core';
import { and, eq, gt, isNull, count, sql } from 'drizzle-orm';
import type { Request } from 'express';
import { config, SESSION_COOKIE } from '../config';
import { randomToken, sha256 } from '../common/crypto';
import { bearerToken, parseCookies } from '../common/http';
import { InjectDb, type Db } from '../db/db.module';
import { apiTokens, oauthGrants, sessions, users, type UserRow } from '../db/schema';

export interface AuthContext {
  user: UserRow;
  via: 'session' | 'api_token' | 'oauth';
  /** Session or token id, used e.g. for logout */
  credentialId: string;
}

export function toUser(r: UserRow): User {
  return { id: r.id, email: r.email, name: r.name, timezone: r.timezone, createdAt: r.createdAt.toISOString() };
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
  constructor(@InjectDb() private readonly db: Db) {}

  async signupAllowed(): Promise<boolean> {
    if (config.signupMode === 'open') return true;
    if (config.signupMode === 'closed') return false;
    const [row] = await this.db.select({ n: count() }).from(users);
    return (row?.n ?? 0) === 0;
  }

  async signup(input: SignupInput) {
    const passwordHash = await Bun.password.hash(input.password);
    const user = await this.db.transaction(async (tx) => {
      // Serialize sign-ups so two people can't both become "the first user".
      await tx.execute(sql`select pg_advisory_xact_lock(731_6001)`);
      if (config.signupMode === 'closed') throw new ForbiddenException('이 서버는 새 계정 가입을 받지 않습니다');
      if (config.signupMode === 'first') {
        const [row] = await tx.select({ n: count() }).from(users);
        if ((row?.n ?? 0) > 0) throw new ForbiddenException('이 서버는 새 계정 가입을 받지 않습니다');
      }
      const existing = await tx.query.users.findFirst({ where: eq(users.email, input.email) });
      if (existing) throw new ConflictException('이미 가입된 이메일입니다');
      const [created] = await tx
        .insert(users)
        .values({ email: input.email, name: input.name, passwordHash, timezone: input.timezone ?? 'Asia/Seoul' })
        .returning();
      return created!;
    });
    const token = await this.createSession(user.id);
    return { user, token };
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

  async updateMe(userId: string, patch: { name?: string; timezone?: string }) {
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
        .select({ user: users, id: apiTokens.id, lastUsedAt: apiTokens.lastUsedAt })
        .from(apiTokens)
        .innerJoin(users, eq(users.id, apiTokens.userId))
        .where(and(eq(apiTokens.tokenHash, hash), isNull(apiTokens.revokedAt)))
        .limit(1);
      const hit = rows[0];
      if (!hit) return null;
      if (!hit.lastUsedAt || Date.now() - hit.lastUsedAt.getTime() > 60_000) {
        await this.db.update(apiTokens).set({ lastUsedAt: sql`now()` }).where(eq(apiTokens.id, hit.id));
      }
      return { user: hit.user, via: 'api_token', credentialId: hit.id };
    }
    if (token.startsWith('oat_')) {
      const rows = await this.db
        .select({ user: users, id: oauthGrants.id, lastUsedAt: oauthGrants.lastUsedAt })
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
      return { user: hit.user, via: 'oauth', credentialId: hit.id };
    }
    return null;
  }
}
