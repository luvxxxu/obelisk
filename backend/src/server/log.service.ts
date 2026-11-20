import { Injectable } from '@nestjs/common';
import type { AdminLogEntry } from '@obelisk/core';
import { count, desc } from 'drizzle-orm';
import { InjectDb, type Db } from '../db/db.module';
import { adminLog } from '../db/schema';
import type { Conn } from '../workspace/access.service';

export type LogActor = { id: string; name: string } | null;
export type LogTarget = { id: string; email?: string; name?: string } | { label: string; id?: string } | null;

function label(t: LogTarget): string {
  if (!t) return '';
  if ('label' in t) return t.label;
  return t.email ? `${t.name ?? ''} <${t.email}>`.trim() : (t.name ?? '');
}

/** The operator log: what was done to which account or setting, by whom. Readable by operators only. */
@Injectable()
export class AdminLogService {
  constructor(@InjectDb() private readonly db: Db) {}

  async record(conn: Conn, actor: LogActor, action: string, target: LogTarget, data: Record<string, unknown> = {}) {
    await conn.insert(adminLog).values({
      actorId: actor?.id ?? null,
      actorName: actor?.name ?? '서버',
      action,
      targetId: target && 'id' in target && target.id ? target.id : null,
      targetLabel: label(target),
      data,
    });
  }

  async list(offset = 0, limit = 50): Promise<{ entries: AdminLogEntry[]; total: number }> {
    const [rows, [n]] = await Promise.all([
      this.db.select().from(adminLog).orderBy(desc(adminLog.createdAt)).offset(offset).limit(limit),
      this.db.select({ n: count() }).from(adminLog),
    ]);
    return {
      entries: rows.map((r) => ({
        id: r.id,
        actorId: r.actorId,
        actorName: r.actorName,
        action: r.action,
        targetId: r.targetId,
        targetLabel: r.targetLabel,
        data: r.data,
        createdAt: r.createdAt.toISOString(),
      })),
      total: n?.n ?? 0,
    };
  }
}
