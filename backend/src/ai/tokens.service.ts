import { Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { randomToken, sha256 } from '../common/crypto';
import { InjectDb, type Db } from '../db/db.module';
import { apiTokens, oauthGrants } from '../db/schema';

@Injectable()
export class TokensService {
  constructor(@InjectDb() private readonly db: Db) {}

  async list(userId: string) {
    const rows = await this.db
      .select({
        id: apiTokens.id,
        name: apiTokens.name,
        prefix: apiTokens.prefix,
        lastUsedAt: apiTokens.lastUsedAt,
        createdAt: apiTokens.createdAt,
      })
      .from(apiTokens)
      .where(and(eq(apiTokens.userId, userId), isNull(apiTokens.revokedAt)))
      .orderBy(desc(apiTokens.createdAt));
    return rows;
  }

  /** The plaintext token is returned exactly once. */
  async create(userId: string, name: string) {
    const token = randomToken('obk', 24);
    const [row] = await this.db
      .insert(apiTokens)
      .values({ userId, name, prefix: `${token.slice(0, 10)}…`, tokenHash: sha256(token) })
      .returning();
    return { token, id: row!.id, name: row!.name, prefix: row!.prefix, createdAt: row!.createdAt };
  }

  async revoke(userId: string, id: string) {
    const res = await this.db
      .update(apiTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(apiTokens.id, id), eq(apiTokens.userId, userId), isNull(apiTokens.revokedAt)))
      .returning({ id: apiTokens.id });
    if (!res.length) throw new NotFoundException('토큰을 찾을 수 없습니다');
    return { ok: true };
  }

  async listGrants(userId: string) {
    return this.db
      .select({
        id: oauthGrants.id,
        clientId: oauthGrants.clientId,
        clientName: oauthGrants.clientName,
        scope: oauthGrants.scope,
        lastUsedAt: oauthGrants.lastUsedAt,
        createdAt: oauthGrants.createdAt,
      })
      .from(oauthGrants)
      .where(and(eq(oauthGrants.userId, userId), isNull(oauthGrants.revokedAt)))
      .orderBy(desc(oauthGrants.createdAt));
  }

  async revokeGrant(userId: string, id: string) {
    const res = await this.db
      .update(oauthGrants)
      .set({ revokedAt: new Date() })
      .where(and(eq(oauthGrants.id, id), eq(oauthGrants.userId, userId), isNull(oauthGrants.revokedAt)))
      .returning({ id: oauthGrants.id });
    if (!res.length) throw new NotFoundException('연결을 찾을 수 없습니다');
    return { ok: true };
  }
}
