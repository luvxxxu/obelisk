import { BadRequestException, Injectable, PayloadTooLargeException } from '@nestjs/common';
import { and, eq, ne } from 'drizzle-orm';
import { sniffImage, type ImageInfo } from '../common/image';
import { InjectDb, type Db } from '../db/db.module';
import { avatars, users, workspaces, type UserRow } from '../db/schema';
import type { Access } from './access.service';
import { ActivityService } from './activity.service';

/** The browser sends 256 px; this leaves room for a sharper PNG without letting anyone store posters. */
export const AVATAR_MAX_BYTES = 512 * 1024;
export const AVATAR_MAX_SIDE = 1024;
/** Content types the raw body parser hands to the upload routes as a Buffer. */
export const AVATAR_UPLOAD_TYPES = ['image/webp', 'image/png', 'image/jpeg'];

/** Where a photo is served. Same-origin and relative: the web app proxies /api, the iOS app knows its server. */
export function avatarPath(id: string | null | undefined): string | null {
  return id ? `/api/avatars/${id}` : null;
}

/** Check an upload body: a real WebP, PNG or JPEG, small enough in bytes and pixels. */
export function readAvatar(body: unknown): { data: Buffer; info: ImageInfo } {
  if (!Buffer.isBuffer(body) || body.length === 0) {
    throw new BadRequestException('사진 파일을 보내 주세요 (WebP, PNG, JPEG)');
  }
  if (body.length > AVATAR_MAX_BYTES) throw new PayloadTooLargeException('사진이 너무 큽니다. 512KB 이하로 줄여 주세요');
  const info = sniffImage(body);
  if (!info) throw new BadRequestException('WebP, PNG, JPEG 사진만 올릴 수 있습니다');
  if (!info.width || !info.height || info.width > AVATAR_MAX_SIDE || info.height > AVATAR_MAX_SIDE) {
    throw new BadRequestException(`사진은 가로세로 ${AVATAR_MAX_SIDE}px 이하여야 합니다`);
  }
  return { data: body, info };
}

@Injectable()
export class AvatarsService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly activity: ActivityService,
  ) {}

  get(id: string) {
    return this.db.query.avatars.findFirst({ where: eq(avatars.id, id) });
  }

  // ───────── people (anyone, for themselves)

  async setForUser(userId: string, body: unknown): Promise<UserRow> {
    const { data, info } = readAvatar(body);
    return this.db.transaction(async (tx) => {
      // One upload at a time per person, so two quick saves can't leave the photo pointing at a deleted row.
      await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).for('update');
      const [row] = await tx.insert(avatars).values({ userId, contentType: info.type, data }).returning({ id: avatars.id });
      const [user] = await tx.update(users).set({ avatarId: row!.id }).where(eq(users.id, userId)).returning();
      await tx.delete(avatars).where(and(eq(avatars.userId, userId), ne(avatars.id, row!.id)));
      return user!;
    });
  }

  async clearForUser(userId: string): Promise<UserRow> {
    return this.db.transaction(async (tx) => {
      const [user] = await tx.update(users).set({ avatarId: null }).where(eq(users.id, userId)).returning();
      await tx.delete(avatars).where(eq(avatars.userId, userId));
      return user!;
    });
  }

  // ───────── organizations (owners and admins, like the name)

  async setForWorkspace(a: Access, body: unknown) {
    a.assertOrg();
    a.assertAdmin('조직 사진 변경');
    const { data, info } = readAvatar(body);
    await this.db.transaction(async (tx) => {
      const [locked] = await tx
        .select({ avatarId: workspaces.avatarId })
        .from(workspaces)
        .where(eq(workspaces.id, a.workspaceId))
        .for('update');
      const [row] = await tx
        .insert(avatars)
        .values({ workspaceId: a.workspaceId, contentType: info.type, data })
        .returning({ id: avatars.id });
      await tx.update(workspaces).set({ avatarId: row!.id, updatedAt: new Date() }).where(eq(workspaces.id, a.workspaceId));
      await tx.delete(avatars).where(and(eq(avatars.workspaceId, a.workspaceId), ne(avatars.id, row!.id)));
      await this.activity.record(tx, a, {
        action: 'workspace.updated',
        subject: a.workspace.name,
        data: { changes: { photo: { from: !!locked?.avatarId, to: true } } },
      });
    });
  }

  async clearForWorkspace(a: Access) {
    a.assertOrg();
    a.assertAdmin('조직 사진 삭제');
    if (!a.workspace.avatarId) return;
    await this.db.transaction(async (tx) => {
      await tx.update(workspaces).set({ avatarId: null, updatedAt: new Date() }).where(eq(workspaces.id, a.workspaceId));
      await tx.delete(avatars).where(eq(avatars.workspaceId, a.workspaceId));
      await this.activity.record(tx, a, {
        action: 'workspace.updated',
        subject: a.workspace.name,
        data: { changes: { photo: { from: true, to: false } } },
      });
    });
  }
}
