import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import {
  countedMinutes,
  todayIn,
  workHoursOf,
  type RunningTimer,
  type TaskStatus,
  type TimeEntry,
  type TimeEntrySource,
} from '@obelisk/core';
import { and, desc, eq, gte, inArray, isNull, isNotNull, sql } from 'drizzle-orm';
import type { AuthContext } from '../auth/auth.service';
import { InjectDb, type Db } from '../db/db.module';
import { tasks, timeEntries, users, type TaskRow, type TimeEntryRow, type UserRow } from '../db/schema';
import { AccessService, type Access, type Conn } from '../workspace/access.service';

export interface TimeEntryView extends TimeEntry {
  /** null: someone who left. */
  userName: string | null;
  /** The caller's own entry: they may delete it. */
  mine: boolean;
}

export function toEntry(r: TimeEntryRow): TimeEntry {
  return {
    id: r.id,
    workspaceId: r.workspaceId,
    taskId: r.taskId,
    userId: r.userId,
    source: r.source,
    startedAt: r.startedAt.toISOString(),
    endedAt: r.endedAt?.toISOString() ?? null,
    minutes: r.minutes ?? null,
    createdAt: r.createdAt.toISOString(),
  };
}

/**
 * Time spent on tasks. A task put in progress starts an `auto` entry for whoever did it; finishing,
 * pausing or reopening it stops the clock. A timer is the same thing started by hand. One clock runs
 * per person at a time, across all their spaces: starting another stops the one before.
 * `tasks.actual_minutes` is always the sum of the finished entries.
 */
@Injectable()
export class TimeService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly access: AccessService,
  ) {}

  // ───────────────────────────── internals

  /** Recount the total of each task from its finished entries. */
  private async recount(conn: Conn, taskIds: string[]) {
    const ids = [...new Set(taskIds)];
    if (!ids.length) return;
    await conn
      .update(tasks)
      .set({
        actualMinutes: sql`(select coalesce(sum(${timeEntries.minutes}), 0)::int from ${timeEntries} where ${timeEntries.taskId} = ${tasks.id} and ${timeEntries.endedAt} is not null)`,
      })
      .where(inArray(tasks.id, ids));
  }

  /** Stop running entries, counting each in its owner's time zone and work hours. */
  private async close(conn: Conn, rows: TimeEntryRow[], opts: { at?: Date; asTimer?: boolean } = {}) {
    if (!rows.length) return;
    const at = opts.at ?? new Date();
    const ids = [...new Set(rows.map((r) => r.userId).filter((id): id is string => !!id))];
    const owners = ids.length ? await conn.query.users.findMany({ where: inArray(users.id, ids) }) : [];
    const byId = new Map(owners.map((u) => [u.id, u]));
    for (const r of rows) {
      const owner = r.userId ? byId.get(r.userId) : undefined;
      const source: TimeEntrySource = opts.asTimer && r.source === 'auto' ? 'timer' : r.source;
      const minutes = countedMinutes(source, r.startedAt, at, owner?.timezone ?? 'UTC', workHoursOf(owner?.workHours));
      await conn.update(timeEntries).set({ endedAt: at, minutes, source }).where(eq(timeEntries.id, r.id));
    }
    await this.recount(
      conn,
      rows.map((r) => r.taskId),
    );
  }

  private runningOf(conn: Conn, userId: string) {
    return conn.query.timeEntries.findFirst({ where: and(eq(timeEntries.userId, userId), isNull(timeEntries.endedAt)) });
  }

  /** Start `user`'s clock on a task, stopping whatever ran before. */
  private async start(conn: Conn, user: UserRow, task: Pick<TaskRow, 'id' | 'workspaceId'>, source: TimeEntrySource) {
    const running = await this.runningOf(conn, user.id);
    if (running?.taskId === task.id) {
      if (source === 'timer' && running.source === 'auto') {
        await conn.update(timeEntries).set({ source: 'timer' }).where(eq(timeEntries.id, running.id));
      }
      return;
    }
    if (running) await this.close(conn, [running]);
    await conn.insert(timeEntries).values({ workspaceId: task.workspaceId, taskId: task.id, userId: user.id, source, startedAt: new Date() });
  }

  /**
   * Called by TasksService when a status changes. Returns true when time was recorded (the task's
   * total changed, so the caller re-reads it).
   */
  async onStatus(conn: Conn, a: Access, task: TaskRow, prev: TaskStatus): Promise<boolean> {
    if (task.status === 'doing' && prev !== 'doing') {
      await this.start(conn, a.user, task, 'auto');
      return false;
    }
    if (prev === 'doing' && task.status !== 'doing') {
      const running = await conn.query.timeEntries.findMany({ where: and(eq(timeEntries.taskId, task.id), isNull(timeEntries.endedAt)) });
      await this.close(conn, running);
      return running.length > 0;
    }
    return false;
  }

  /** A task the caller may log time on (edit access). */
  private async editableTask(auth: AuthContext, taskId: string) {
    const a = await this.access.forTask(auth, taskId);
    const task = await this.db.query.tasks.findFirst({ where: and(eq(tasks.id, taskId), eq(tasks.workspaceId, a.workspaceId)) });
    if (!task || !a.taskLevel(task)) throw new NotFoundException('작업을 찾을 수 없습니다');
    a.assertTaskEditable(task);
    return { a, task };
  }

  // ───────────────────────────── reads

  /** The caller's running clock, with its task. A clock on a task they can no longer see is stopped. */
  async running(auth: AuthContext): Promise<RunningTimer | null> {
    const row = await this.runningOf(this.db, auth.user.id);
    if (!row) return null;
    const task = await this.db.query.tasks.findFirst({ where: eq(tasks.id, row.taskId) });
    const a = task ? await this.access.forWorkspace(auth, task.workspaceId).catch(() => null) : null;
    if (!task || !a || !a.taskLevel(task)) {
      await this.close(this.db, [row]);
      return null;
    }
    return {
      entry: toEntry(row),
      task: {
        id: task.id,
        number: task.number,
        title: task.title,
        workspaceId: task.workspaceId,
        projectId: task.projectId,
        status: task.status,
        estimateMinutes: task.estimateMinutes,
        actualMinutes: task.actualMinutes,
      },
    };
  }

  /** Everyone's entries on a task the caller can see, newest first. */
  async forTask(a: Access, taskId: string): Promise<TimeEntryView[]> {
    const task = await this.db.query.tasks.findFirst({ where: and(eq(tasks.id, taskId), eq(tasks.workspaceId, a.workspaceId)) });
    if (!task || !a.taskLevel(task)) throw new NotFoundException('작업을 찾을 수 없습니다');
    const rows = await this.db
      .select({ e: timeEntries, name: users.name })
      .from(timeEntries)
      .leftJoin(users, eq(users.id, timeEntries.userId))
      .where(eq(timeEntries.taskId, taskId))
      .orderBy(desc(timeEntries.startedAt))
      .limit(200);
    return rows.map((r) => ({ ...toEntry(r.e), userName: r.name, mine: r.e.userId === a.userId }));
  }

  /** Minutes the user tracked on each recent day that has any (for learning focus). */
  async trackedPerDay(userId: string, timezone: string, days = 28): Promise<number[]> {
    const since = new Date(Date.now() - days * 86_400_000);
    const rows = await this.db
      .select({ startedAt: timeEntries.startedAt, minutes: timeEntries.minutes })
      .from(timeEntries)
      .where(and(eq(timeEntries.userId, userId), isNotNull(timeEntries.endedAt), gte(timeEntries.startedAt, since)));
    const byDay = new Map<string, number>();
    for (const r of rows) {
      const day = todayIn(timezone, r.startedAt);
      byDay.set(day, (byDay.get(day) ?? 0) + (r.minutes ?? 0));
    }
    return [...byDay.values()].filter((m) => m > 0);
  }

  // ───────────────────────────── writes

  /** Start or stop the caller's timer on a task. Starting a timer puts a to-do task in progress. */
  async timer(auth: AuthContext, taskId: string, action: 'start' | 'stop') {
    const { a, task } = await this.editableTask(auth, taskId);
    if (action === 'start') {
      if (task.status === 'done' || task.status === 'canceled') throw new BadRequestException('끝난 작업에는 타이머를 켤 수 없어요. 먼저 다시 열어 주세요.');
      await this.db.transaction((tx) => this.start(tx, a.user, task, 'timer'));
      return { a, startDoing: task.status === 'todo' };
    }
    await this.db.transaction(async (tx) => {
      const running = await tx.query.timeEntries.findMany({
        where: and(eq(timeEntries.taskId, taskId), eq(timeEntries.userId, a.userId), isNull(timeEntries.endedAt)),
      });
      await this.close(tx, running, { asTimer: true });
    });
    return { a, startDoing: false };
  }

  /** Add time done earlier ("30분 했어요"). */
  async addManual(auth: AuthContext, taskId: string, minutes: number, date?: string) {
    const { a, task } = await this.editableTask(auth, taskId);
    const today = todayIn(a.user.timezone);
    if (date && date > today) throw new BadRequestException('앞으로의 날짜에는 기록할 수 없어요');
    // Ends now (today) or at the same wall time on the given past day: only the day matters later.
    const end = new Date(Date.now() - (date ? Date.parse(today) - Date.parse(date) : 0));
    const start = new Date(end.getTime() - minutes * 60_000);
    await this.db.transaction(async (tx) => {
      await tx.insert(timeEntries).values({ workspaceId: task.workspaceId, taskId, userId: a.userId, source: 'manual', startedAt: start, endedAt: end, minutes });
      await this.recount(tx, [taskId]);
    });
  }

  /** Your own entries only. Returns the task id. */
  async remove(auth: AuthContext, entryId: string): Promise<string> {
    const row = await this.db.query.timeEntries.findFirst({ where: eq(timeEntries.id, entryId) });
    if (!row) throw new NotFoundException('기록을 찾을 수 없습니다');
    if (row.userId !== auth.user.id) throw new ForbiddenException('다른 사람의 기록은 지울 수 없어요');
    await this.db.transaction(async (tx) => {
      await tx.delete(timeEntries).where(eq(timeEntries.id, entryId));
      await this.recount(tx, [row.taskId]);
    });
    return row.taskId;
  }

  /**
   * "실제로는 1시간 30분 걸렸어요": your time on the task becomes exactly this. Your entries on it
   * (a running one included) are replaced by one; other people's stay.
   */
  async setActual(auth: AuthContext, taskId: string, minutes: number) {
    const { a, task } = await this.editableTask(auth, taskId);
    await this.db.transaction(async (tx) => {
      const mine = and(eq(timeEntries.taskId, taskId), eq(timeEntries.userId, a.userId));
      const first = await tx.query.timeEntries.findFirst({ where: mine, orderBy: timeEntries.startedAt });
      await tx.delete(timeEntries).where(mine);
      if (minutes > 0) {
        const end = new Date();
        const start = first?.startedAt ?? new Date(end.getTime() - minutes * 60_000);
        await tx.insert(timeEntries).values({ workspaceId: task.workspaceId, taskId, userId: a.userId, source: 'manual', startedAt: start, endedAt: end, minutes });
      }
      await this.recount(tx, [taskId]);
    });
  }
}
