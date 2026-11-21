import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import {
  nowIn,
  planDay,
  toMinutes,
  todayIn,
  workHoursOf,
  type DayPlan,
  type DayProposalResponse,
  type DayView,
  type ISODate,
  type ISOTime,
  type PlannerTask,
  type Task,
  type TimeBlock,
} from '@obelisk/core';
import { and, eq, gte, lte, notInArray } from 'drizzle-orm';
import type { AuthContext } from '../auth/auth.service';
import { InjectDb, type Db } from '../db/db.module';
import { timeBlocks, type TimeBlockRow } from '../db/schema';
import { TimeService } from './time.service';
import { WorkService, type Space } from './work.service';

export function toBlock(r: TimeBlockRow): TimeBlock {
  return {
    id: r.id,
    userId: r.userId,
    workspaceId: r.workspaceId,
    taskId: r.taskId,
    date: r.date,
    start: r.start,
    end: r.end,
    locked: r.locked,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

const plannerTask = (t: Task): PlannerTask => ({
  id: t.id,
  title: t.title,
  number: t.number,
  workspaceId: t.workspaceId,
  projectId: t.projectId,
  status: t.status,
  priority: t.priority,
  fixed: t.fixed,
  startDate: t.startDate,
  startTime: t.startTime,
  dueDate: t.dueDate,
  dueTime: t.dueTime,
  estimateMinutes: t.estimateMinutes,
  actualMinutes: t.actualMinutes,
  postponedCount: t.postponedCount,
  position: t.position,
});

/**
 * Day plans: a person's own blocks of time for tasks, one day across all their spaces. Nobody else
 * sees them. The planner (core planDay) packs the day's work around timed tasks and breaks.
 */
@Injectable()
export class PlanService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly work: WorkService,
    private readonly time: TimeService,
  ) {}

  private async context(auth: AuthContext, date: ISODate) {
    const spaces = await this.work.spaces(auth);
    const [active, calibration, running, saved] = await Promise.all([
      this.work.active(spaces),
      this.work.calibration(auth.user, spaces.map((s) => s.a), true),
      this.time.running(auth),
      this.db.query.timeBlocks.findMany({ where: and(eq(timeBlocks.userId, auth.user.id), eq(timeBlocks.date, date)) }),
    ]);
    const hours = workHoursOf(auth.user.workHours);
    const tasks = active.flatMap((x) => x.tasks);
    const deps = active.flatMap((x) => x.deps);
    // Blocks on tasks that aren't active work of mine any more (done, reassigned) still show, if visible.
    const known = new Set(tasks.map((t) => t.id));
    const extra = await this.work.visibleByIds(
      spaces,
      saved.map((b) => b.taskId).filter((id) => !known.has(id)),
    );
    const blocks = saved.filter((b) => known.has(b.taskId) || extra.has(b.taskId));
    return { spaces, tasks, deps, extra, hours, calibration, running, blocks };
  }

  private input(ctx: Awaited<ReturnType<PlanService['context']>>, auth: AuthContext, date: ISODate, lockAll: boolean, fillAhead = false) {
    return {
      date,
      now: nowIn(auth.user.timezone),
      hours: ctx.hours,
      tasks: [...ctx.tasks, ...ctx.extra.values()].map(plannerTask),
      deps: ctx.deps,
      blocks: ctx.blocks.map((b) => ({ id: b.id, taskId: b.taskId, start: b.start, end: b.end, locked: lockAll || b.locked })),
      defaultEstimate: ctx.calibration.defaultEstimate,
      runningTaskId: ctx.running?.entry.taskId ?? null,
      fillAhead,
    };
  }

  private spaceOf(spaces: Space[], workspaceId: string) {
    return spaces.find((s) => s.a.workspaceId === workspaceId)!;
  }

  async day(auth: AuthContext, date: ISODate): Promise<DayView> {
    const ctx = await this.context(auth, date);
    const input = this.input(ctx, auth, date, true);
    // With every saved block held in place, whatever the planner adds is the work still without a block.
    const plan = planDay(input);
    const pending = new Map<string, { minutes: number; reason: DayView['pending'][number]['reason'] }>();
    for (const b of plan.blocks) {
      if (b.kept) continue;
      const cur = pending.get(b.taskId) ?? { minutes: 0, reason: null };
      cur.minutes += toMinutes(b.end) - toMinutes(b.start);
      pending.set(b.taskId, cur);
    }
    for (const u of plan.unplaced) {
      const cur = pending.get(u.taskId) ?? { minutes: 0, reason: null };
      cur.minutes += u.minutes;
      cur.reason = u.reason;
      pending.set(u.taskId, cur);
    }
    const now = input.now;
    const nowMin = now.date === date ? now.minutes : now.date > date ? 1440 : 0;
    const ahead = (b: { start: ISOTime; end: ISOTime }) => Math.max(0, toMinutes(b.end) - Math.max(toMinutes(b.start), nowMin));

    const all = new Map<string, Task>([...ctx.tasks.map((t) => [t.id, t] as const), ...[...ctx.extra].map(([id, t]) => [id, t] as const)]);
    const late: DayView['late'] = [];
    for (const t of all.values()) {
      if (t.dueDate !== date || !t.dueTime || (t.status !== 'todo' && t.status !== 'doing')) continue;
      const ends = ctx.blocks.filter((b) => b.taskId === t.id).map((b) => b.end);
      const last = ends.sort().at(-1);
      if (last && last > t.dueTime) late.push({ taskId: t.id, dueTime: t.dueTime, end: last });
    }

    const mentioned = new Set([...ctx.blocks.map((b) => b.taskId), ...plan.events.map((e) => e.taskId), ...pending.keys()]);
    const tasks = [...mentioned]
      .map((id) => all.get(id))
      .filter((t): t is Task => !!t)
      .map((t) => this.work.overviewTask(t, this.spaceOf(ctx.spaces, t.workspaceId).a));
    return {
      date,
      today: todayIn(auth.user.timezone),
      now,
      hours: ctx.hours,
      workday: plan.workday,
      defaultEstimate: ctx.calibration.defaultEstimate,
      blocks: ctx.blocks.map(toBlock).sort((a, b) => a.start.localeCompare(b.start)),
      events: plan.events,
      pending: [...pending].map(([taskId, v]) => ({ taskId, ...v })),
      late,
      capacity: plan.capacity,
      planned: ctx.blocks.reduce((n, b) => n + ahead(b), 0),
      needed: [...pending.values()].reduce((n, p) => n + p.minutes, 0) + ctx.blocks.filter((b) => all.get(b.taskId)?.status !== 'done').reduce((n, b) => n + ahead(b), 0),
      tasks,
      projects: await this.work.projectsOf(tasks),
      running: ctx.running,
    };
  }

  /** Plan the day around what's saved (locked and past blocks stay); `apply` saves it. */
  async auto(auth: AuthContext, date: ISODate, opts: { fillAhead?: boolean; apply?: boolean }): Promise<DayProposalResponse> {
    const today = todayIn(auth.user.timezone);
    if (date < today) throw new BadRequestException('지난 날은 다시 계획할 수 없어요');
    const ctx = await this.context(auth, date);
    const plan: DayPlan = planDay(this.input(ctx, auth, date, false, opts.fillAhead));
    const all = new Map<string, Task>([...ctx.tasks.map((t) => [t.id, t] as const), ...ctx.extra]);
    const ids = new Set([...plan.blocks.map((b) => b.taskId), ...plan.events.map((e) => e.taskId), ...plan.unplaced.map((u) => u.taskId)]);
    const tasks = [...ids]
      .map((id) => all.get(id))
      .filter((t): t is Task => !!t)
      .map((t) => this.work.overviewTask(t, this.spaceOf(ctx.spaces, t.workspaceId).a));
    const projects = await this.work.projectsOf(tasks);
    if (!opts.apply) return { plan, tasks, projects, view: null };
    const keep = plan.blocks.filter((b) => b.kept && b.id).map((b) => b.id!);
    await this.db.transaction(async (tx) => {
      const mine = and(eq(timeBlocks.userId, auth.user.id), eq(timeBlocks.date, date));
      await tx.delete(timeBlocks).where(keep.length ? and(mine, notInArray(timeBlocks.id, keep)) : mine);
      const fresh = plan.blocks.filter((b) => !b.kept);
      if (fresh.length) {
        await tx.insert(timeBlocks).values(
          fresh.map((b) => ({ userId: auth.user.id, workspaceId: all.get(b.taskId)!.workspaceId, taskId: b.taskId, date, start: b.start, end: b.end, locked: false })),
        );
      }
    });
    return { plan, tasks, projects, view: await this.day(auth, date) };
  }

  /** Place a block by hand (it is locked: re-planning works around it). */
  async create(auth: AuthContext, input: { taskId: string; date: ISODate; start: ISOTime; end: ISOTime }): Promise<TimeBlock> {
    const spaces = await this.work.spaces(auth);
    const task = (await this.work.visibleByIds(spaces, [input.taskId])).get(input.taskId);
    if (!task) throw new NotFoundException('작업을 찾을 수 없습니다');
    const [row] = await this.db
      .insert(timeBlocks)
      .values({ userId: auth.user.id, workspaceId: task.workspaceId, taskId: task.id, date: input.date, start: input.start, end: input.end, locked: true })
      .returning();
    return toBlock(row!);
  }

  private async own(auth: AuthContext, id: string) {
    const row = await this.db.query.timeBlocks.findFirst({ where: eq(timeBlocks.id, id) });
    if (!row) throw new NotFoundException('블록을 찾을 수 없습니다');
    if (row.userId !== auth.user.id) throw new ForbiddenException('다른 사람의 계획은 바꿀 수 없어요');
    return row;
  }

  /** Moving or resizing a block locks it unless `locked` says otherwise. */
  async update(auth: AuthContext, id: string, patch: { date?: ISODate; start?: ISOTime; end?: ISOTime; locked?: boolean }): Promise<TimeBlock> {
    const cur = await this.own(auth, id);
    const start = patch.start ?? cur.start;
    const end = patch.end ?? cur.end;
    if (start >= end) throw new BadRequestException('블록의 끝이 시작보다 늦어야 해요');
    const moved = patch.date !== undefined || patch.start !== undefined || patch.end !== undefined;
    const [row] = await this.db
      .update(timeBlocks)
      .set({ date: patch.date ?? cur.date, start, end, locked: patch.locked ?? (moved ? true : cur.locked), updatedAt: new Date() })
      .where(eq(timeBlocks.id, id))
      .returning();
    return toBlock(row!);
  }

  async remove(auth: AuthContext, id: string) {
    await this.own(auth, id);
    await this.db.delete(timeBlocks).where(eq(timeBlocks.id, id));
    return { ok: true };
  }

  /** Clear a day's blocks (all, or only the ones the planner placed). */
  async clear(auth: AuthContext, date: ISODate, onlyUnlocked: boolean) {
    const where = and(eq(timeBlocks.userId, auth.user.id), eq(timeBlocks.date, date), ...(onlyUnlocked ? [eq(timeBlocks.locked, false)] : []));
    await this.db.delete(timeBlocks).where(where);
    return { ok: true };
  }

  /** Blocks in a date range (for a week strip). */
  async range(auth: AuthContext, from: ISODate, to: ISODate): Promise<TimeBlock[]> {
    if (from > to) throw new BadRequestException('기간이 올바르지 않아요');
    const rows = await this.db.query.timeBlocks.findMany({
      where: and(eq(timeBlocks.userId, auth.user.id), gte(timeBlocks.date, from), lte(timeBlocks.date, to)),
      orderBy: [timeBlocks.date, timeBlocks.start],
    });
    return rows.map(toBlock);
  }
}
