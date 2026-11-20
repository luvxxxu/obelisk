import { BadGatewayException, BadRequestException, Injectable, PayloadTooLargeException } from '@nestjs/common';
import { MIGRATION_MAX_BYTES, parseMigrationLink, type MigrationCode } from '@obelisk/core';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { gunzipSync } from 'node:zlib';
import { randomToken, sha256 } from '../common/crypto';
import { config } from '../config';
import { InjectDb, type Db } from '../db/db.module';
import { activity, migrationCodes, users, type UserRow, type WorkspaceRow } from '../db/schema';
import { assertDeliverable, UndeliverableError } from '../webhooks/net';

export const CODE_PREFIX = 'omg_';
const PULL_TIMEOUT_MS = 60_000;

const tooLarge = () => new PayloadTooLargeException('가져올 데이터가 64MB를 넘어요');

/** Bytes of a bundle → its JSON value. Gzip is recognized by its magic bytes, whatever the content type said. */
export function decodeBundle(body: Buffer): unknown {
  let bytes = body;
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
    try {
      bytes = gunzipSync(bytes, { maxOutputLength: MIGRATION_MAX_BYTES });
    } catch (e) {
      if (e instanceof RangeError || (e as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE') throw tooLarge();
      throw new BadRequestException('압축을 풀 수 없는 파일이에요');
    }
  }
  if (bytes.length > MIGRATION_MAX_BYTES) throw tooLarge();
  // A UTF-8 byte order mark is cut off the bytes (not the decoded text, which would copy it once more).
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) bytes = bytes.subarray(3);
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new BadRequestException('Obelisk 내보내기 파일이 아니에요');
  }
}

/** Read a stream into memory, refusing more than `max` bytes. */
export async function readCapped(stream: AsyncIterable<Uint8Array>, max: number, declared?: number | null): Promise<Buffer> {
  if (declared && declared > max) throw tooLarge();
  const parts: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > max) throw tooLarge();
    parts.push(Buffer.from(chunk));
  }
  return Buffer.concat(parts);
}

/** Text of an error answer from the other server, if it is one of ours ({ message }). */
async function remoteMessage(res: Response): Promise<string | null> {
  try {
    const text = (await res.text()).slice(0, 4000);
    const m = (JSON.parse(text) as { message?: unknown }).message;
    return typeof m === 'string' && m.trim() ? m.trim().slice(0, 200) : null;
  } catch {
    return null;
  }
}

/**
 * The two ends of 다른 서버로 바로 보내기: the source mints a one-time code (the 이전 링크) and later
 * hands the bundle to whichever server presents it; the target follows a pasted link and fetches it.
 */
@Injectable()
export class TransferService {
  /** Tests replace the network. */
  transport: typeof fetch = fetch;

  constructor(@InjectDb() private readonly db: Db) {}

  // ───────────────────────────── source side

  /** A new 이전 링크; the person's earlier unused links for this workspace stop working at once. */
  async createCode(userId: string, ws: WorkspaceRow): Promise<MigrationCode> {
    const code = randomToken('omg', 24);
    const expiresAt = new Date(Date.now() + config.migrationCodeMinutes * 60_000);
    await this.db.transaction(async (tx) => {
      // Used codes stay as the record of what was pulled.
      await tx
        .delete(migrationCodes)
        .where(and(eq(migrationCodes.userId, userId), eq(migrationCodes.workspaceId, ws.id), isNull(migrationCodes.usedAt)));
      await tx.insert(migrationCodes).values({ id: sha256(code), userId, workspaceId: ws.id, expiresAt });
    });
    return { link: `${config.publicUrl}/settings/migrate#${code}`, expiresAt: expiresAt.toISOString() };
  }

  /** Which workspace a live code is for, without using it up (so a too-large export doesn't burn it). */
  async peekCode(code: string): Promise<{ userId: string; workspaceId: string } | null> {
    if (!code.startsWith(CODE_PREFIX)) return null;
    const row = await this.db.query.migrationCodes.findFirst({
      where: and(eq(migrationCodes.id, sha256(code)), isNull(migrationCodes.usedAt), gt(migrationCodes.expiresAt, sql`now()`)),
    });
    return row ? { userId: row.userId, workspaceId: row.workspaceId } : null;
  }

  /** Marks the code used, atomically: of two servers presenting it at once, one wins. */
  async useCode(code: string): Promise<{ user: UserRow; workspaceId: string } | null> {
    if (!code.startsWith(CODE_PREFIX)) return null;
    const [row] = await this.db
      .update(migrationCodes)
      .set({ usedAt: new Date() })
      .where(and(eq(migrationCodes.id, sha256(code)), isNull(migrationCodes.usedAt), gt(migrationCodes.expiresAt, sql`now()`)))
      .returning();
    if (!row) return null;
    const user = await this.db.query.users.findFirst({ where: eq(users.id, row.userId) });
    return user ? { user, workspaceId: row.workspaceId } : null;
  }

  async recordPulled(user: UserRow, ws: WorkspaceRow, target: string | null) {
    await this.db.insert(activity).values({
      workspaceId: ws.id,
      actorId: user.id,
      actorName: user.name,
      via: 'system',
      client: null,
      action: 'workspace.exported',
      subject: ws.name,
      data: { to: target, secrets: true },
    });
  }

  // ───────────────────────────── target side

  /** Follow a pasted 이전 링크 to its server and bring the bundle back (as parsed JSON). */
  async pull(link: string): Promise<unknown> {
    const target = parseMigrationLink(link);
    if (!target) {
      if (link.trim().startsWith(CODE_PREFIX)) throw new BadRequestException('서버 주소까지 담긴 이전 링크 전체를 붙여 넣으세요');
      throw new BadRequestException('이전 링크 형식이 올바르지 않아요');
    }
    if (target.origin === new URL(config.publicUrl).origin) throw new BadRequestException('같은 서버에서는 가져올 수 없어요');
    const url = `${target.origin}/api/migration/pull`;
    if (!config.migrationAllowPrivate && !url.startsWith('https://')) throw new BadRequestException('이전 링크는 https:// 주소여야 해요');
    try {
      await assertDeliverable(url, config.migrationAllowPrivate);
    } catch (e) {
      if (!(e instanceof UndeliverableError)) throw e;
      throw new BadRequestException(
        e.retryable ? `원래 서버(${new URL(url).host})를 찾지 못했어요` : '내부망·로컬 주소에서는 가져올 수 없어요',
      );
    }

    let res: Response;
    try {
      res = await this.transport(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${target.code}`, 'x-obelisk-target': config.publicUrl, accept: 'application/json' },
        redirect: 'manual',
        signal: AbortSignal.timeout(PULL_TIMEOUT_MS),
      });
    } catch (e) {
      const name = (e as { name?: string })?.name;
      throw new BadGatewayException(
        name === 'TimeoutError' || name === 'AbortError' ? '원래 서버가 60초 안에 답하지 않았어요' : '원래 서버에 연결하지 못했어요',
      );
    }

    if (res.status >= 300 && res.status < 400) throw new BadGatewayException('원래 서버가 다른 주소로 넘겨서 가져오지 않았어요');
    if (res.status === 401) throw new BadRequestException('이전 링크가 만료됐거나 이미 쓰였어요');
    if (res.status === 403) throw new BadRequestException((await remoteMessage(res)) ?? '원래 서버에서 내보낼 권한이 없어요');
    if (res.status === 404) throw new BadGatewayException('그 주소에서 Obelisk 이전 기능을 찾지 못했어요. 원래 서버를 최신 버전으로 업데이트하세요');
    if (res.status === 413) throw new BadRequestException((await remoteMessage(res)) ?? '가져올 데이터가 64MB를 넘어요');
    if (res.status === 429) throw new BadGatewayException('원래 서버에 요청이 너무 많아요. 잠시 후 다시 시도하세요');
    if (!res.ok || !res.body) throw new BadGatewayException(`원래 서버가 오류로 답했어요 (${res.status})`);

    const declared = Number(res.headers.get('content-length') ?? '') || null;
    let body: Buffer;
    try {
      body = await readCapped(res.body as unknown as AsyncIterable<Uint8Array>, MIGRATION_MAX_BYTES, declared);
    } catch (e) {
      if (e instanceof PayloadTooLargeException) throw e;
      throw new BadGatewayException('원래 서버의 응답을 끝까지 받지 못했어요');
    }
    try {
      return decodeBundle(body);
    } catch (e) {
      if (e instanceof PayloadTooLargeException) throw e;
      throw new BadGatewayException('원래 서버의 응답을 읽을 수 없어요');
    }
  }
}
