import { Injectable } from '@nestjs/common';
import type { ActivityEntry, ActivityQuery } from '@obelisk/core';
import { and, desc, eq, inArray, isNotNull, isNull, lt, not, or, type SQL } from 'drizzle-orm';
import { InjectDb, type Db } from '../db/db.module';
import { activity, tasks, type ActivityRow } from '../db/schema';
import type { Access, Conn } from './access.service';

export interface ActivityInput {
  action: string;
  projectId?: string | null;
  taskId?: string | null;
  /** Name of the thing at the time ("#12 기획서", a project or member name). */
  subject?: string;
  data?: Record<string, unknown>;
}

/** One `{ from, to }` per field that actually changed. */
export function diff<T extends Record<string, unknown>>(before: T, after: Partial<T>, fields: (keyof T)[]) {
  const out: Record<string, { from: unknown; to: unknown }> = {};
  for (const f of fields) {
    if (!(f in after) || after[f] === undefined) continue;
    if (JSON.stringify(before[f] ?? null) === JSON.stringify(after[f] ?? null)) continue;
    out[f as string] = { from: before[f] ?? null, to: after[f] ?? null };
  }
  return out;
}

function toEntry(r: ActivityRow): ActivityEntry {
  return {
    id: r.id,
    action: r.action,
    actor: { id: r.actorId, name: r.actorName },
    via: r.via,
    client: r.client,
    projectId: r.projectId,
    taskId: r.taskId,
    subject: r.subject,
    data: r.data,
    createdAt: r.createdAt.toISOString(),
  };
}

@Injectable()
export class ActivityService {
  constructor(@InjectDb() private readonly db: Db) {}

  async record(conn: Conn, a: Access, input: ActivityInput) {
    await this.recordIn(conn, a, a.workspaceId, input);
  }

  /** Same, into another workspace (moving a project writes to both). */
  async recordIn(conn: Conn, a: Pick<Access, 'user' | 'via' | 'client'>, workspaceId: string, input: ActivityInput) {
    await conn.insert(activity).values({
      workspaceId,
      actorId: a.user.id,
      actorName: a.user.name,
      via: a.via,
      client: a.client,
      action: input.action,
      projectId: input.projectId ?? null,
      taskId: input.taskId ?? null,
      subject: input.subject ?? '',
      data: input.data ?? {},
    });
  }

  /** A task's own history. The caller must already have checked that they can see the task. */
  async forTask(a: Access, taskId: string, limit = 100): Promise<ActivityEntry[]> {
    const rows = await this.db
      .select()
      .from(activity)
      .where(and(eq(activity.workspaceId, a.workspaceId), eq(activity.taskId, taskId)))
      .orderBy(desc(activity.createdAt))
      .limit(limit);
    return this.redact(a, rows.map(toEntry));
  }

  /**
   * Entries can name a second task (the blocker of a link, the task whose delay pushed this
   * one). If the reader can't see that task, its name is hidden.
   */
  private async redact(a: Access, entries: ActivityEntry[]): Promise<ActivityEntry[]> {
    const refs = new Set<string>();
    for (const e of entries) {
      for (const k of ['blockedById', 'causeId'] as const) {
        const id = e.data[k];
        if (typeof id === 'string') refs.add(id);
      }
    }
    if (!refs.size || a.kind === 'personal') return entries;
    const visible = new Set(
      (
        await this.db
          .select({ id: tasks.id })
          .from(tasks)
          .where(and(a.taskScope(), inArray(tasks.id, [...refs])))
      ).map((r) => r.id),
    );
    return entries.map((e) => {
      const data = { ...e.data };
      if (typeof data.blockedById === 'string' && !visible.has(data.blockedById)) data.blockedBy = '볼 수 없는 작업';
      if (typeof data.causeId === 'string' && !visible.has(data.causeId)) data.cause = '볼 수 없는 작업';
      return data === e.data ? e : { ...e, data };
    });
  }

  /**
   * Admins see the whole workspace except other people's private (no project) tasks, which
   * stay private even in the log. Everyone else sees what happened in projects they can see
   * now and to private tasks of their own. Member/team/invite events have neither project
   * nor task and stay admin-only.
   */
  async list(a: Access, q: ActivityQuery = {}): Promise<ActivityEntry[]> {
    const conds: SQL[] = [eq(activity.workspaceId, a.workspaceId)];
    if (q.taskId) conds.push(eq(activity.taskId, q.taskId));
    if (q.projectId) conds.push(eq(activity.projectId, q.projectId));
    if (q.actorId) conds.push(eq(activity.actorId, q.actorId));
    if (q.before) conds.push(lt(activity.createdAt, new Date(q.before)));
    if (a.kind === 'org') {
      const inboxTasks = this.db
        .select({ id: tasks.id })
        .from(tasks)
        .where(and(a.taskScope(), isNull(tasks.projectId)));
      const privateTask = and(isNull(activity.projectId), isNotNull(activity.taskId))!;
      // Your own private tasks (still around, or ones you deleted yourself).
      const mine = and(privateTask, or(inArray(activity.taskId, inboxTasks), eq(activity.actorId, a.userId)))!;
      if (a.admin) {
        conds.push(or(not(privateTask), mine)!);
      } else {
        const visible = a.visibleProjectIds();
        conds.push(or(...(visible.length ? [inArray(activity.projectId, visible)] : []), mine)!);
      }
    }
    const rows = await this.db
      .select()
      .from(activity)
      .where(and(...conds))
      .orderBy(desc(activity.createdAt))
      .limit(Math.min(q.limit ?? 50, 200));
    return this.redact(a, rows.map(toEntry));
  }
}
