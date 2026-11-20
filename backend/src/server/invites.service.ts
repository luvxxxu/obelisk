import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { CreateServerInviteInput, ServerInvite } from '@obelisk/core';
import { and, desc, eq, isNull, lt, or, sql } from 'drizzle-orm';
import { randomToken, sha256 } from '../common/crypto';
import { config } from '../config';
import { InjectDb, type Db } from '../db/db.module';
import { serverInvites, users } from '../db/schema';
import type { Conn } from '../workspace/access.service';
import { AdminLogService, type LogActor } from './log.service';

/** Server invite links start with this (organization invites and claim links have their own). */
export const SERVER_INVITE_PREFIX = 'osi_';

export const isServerInvite = (token: string | undefined | null): token is string =>
  !!token && token.trim().startsWith(SERVER_INVITE_PREFIX);

type Row = typeof serverInvites.$inferSelect;

function reason(r: Row): 'revoked' | 'expired' | 'used_up' | null {
  if (r.revokedAt) return 'revoked';
  if (r.expiresAt && r.expiresAt < new Date()) return 'expired';
  if (r.maxUses !== null && r.uses >= r.maxUses) return 'used_up';
  return null;
}

/**
 * Invite links to the server itself: sign-up works with one even when it is invite-only, and the new
 * account skips approval (an operator vouched for whoever holds the link). It joins no organization.
 */
@Injectable()
export class ServerInvitesService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly log: AdminLogService,
  ) {}

  async usable(token: string, conn: Conn = this.db): Promise<boolean> {
    const row = await conn.query.serverInvites.findFirst({ where: eq(serverInvites.tokenHash, sha256(token.trim())) });
    return !!row && !reason(row);
  }

  /** Spend one use inside the sign-up transaction; throws when the link no longer works. */
  async consume(tx: Conn, token: string): Promise<void> {
    const [hit] = await tx
      .update(serverInvites)
      .set({ uses: sql`${serverInvites.uses} + 1` })
      .where(
        and(
          eq(serverInvites.tokenHash, sha256(token.trim())),
          isNull(serverInvites.revokedAt),
          or(isNull(serverInvites.expiresAt), sql`${serverInvites.expiresAt} > now()`),
          or(isNull(serverInvites.maxUses), lt(serverInvites.uses, serverInvites.maxUses)),
        ),
      )
      .returning({ id: serverInvites.id });
    if (!hit) throw new BadRequestException('초대 링크가 만료됐거나 더 이상 쓸 수 없어요');
  }

  async list(): Promise<ServerInvite[]> {
    const rows = await this.db
      .select({ r: serverInvites, by: users.name })
      .from(serverInvites)
      .leftJoin(users, eq(users.id, serverInvites.createdBy))
      .orderBy(desc(serverInvites.createdAt))
      .limit(200);
    return rows.map(({ r, by }) => ({
      id: r.id,
      hint: r.hint,
      note: r.note,
      maxUses: r.maxUses,
      uses: r.uses,
      expiresAt: r.expiresAt?.toISOString() ?? null,
      revokedAt: r.revokedAt?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
      createdBy: by ?? null,
      valid: !reason(r),
    }));
  }

  /** The link is shown once; only its hash is kept. */
  async create(actor: LogActor, input: CreateServerInviteInput): Promise<{ url: string; invite: ServerInvite }> {
    const token = randomToken('osi', 24);
    const expiresAt = input.expiresInDays ? new Date(Date.now() + input.expiresInDays * 86_400_000) : null;
    const row = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(serverInvites)
        .values({
          tokenHash: sha256(token),
          hint: token.slice(-4),
          note: input.note ?? '',
          createdBy: actor?.id ?? null,
          maxUses: input.maxUses ?? null,
          expiresAt,
        })
        .returning();
      await this.log.record(tx, actor, 'invite.created', { label: `…${row!.hint}${input.note ? ` · ${input.note}` : ''}` }, {
        maxUses: row!.maxUses,
        expiresAt: expiresAt?.toISOString() ?? null,
      });
      return row!;
    });
    const invite = (await this.list()).find((i) => i.id === row.id)!;
    return { url: `${config.publicUrl}/signup?invite=${token}`, invite };
  }

  async revoke(actor: LogActor, id: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [row] = await tx
        .update(serverInvites)
        .set({ revokedAt: new Date() })
        .where(and(eq(serverInvites.id, id), isNull(serverInvites.revokedAt)))
        .returning();
      if (!row) throw new NotFoundException('초대 링크를 찾을 수 없어요');
      await this.log.record(tx, actor, 'invite.revoked', { label: `…${row.hint}${row.note ? ` · ${row.note}` : ''}` });
    });
  }
}
