import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  commitOdds,
  forecastOdds,
  NO_HISTORY,
  nowIn,
  summarizeCalibration,
  todayIn,
  UNASSIGNED,
  workHoursOf,
  type Calibration,
  type CommitInput,
  type CommitResponse,
  type OddsInput,
  type OddsPerson,
  type OddsResponse,
  type OddsTask,
  type Task,
} from '@obelisk/core';
import { inArray } from 'drizzle-orm';
import type { AuthContext } from '../auth/auth.service';
import { InjectDb, type Db } from '../db/db.module';
import { users } from '../db/schema';
import type { Access } from '../workspace/access.service';
import { TasksService } from './tasks.service';
import { WorkService } from './work.service';

const oddsTask = (t: Task, queue: string, external = false): OddsTask => ({
  id: t.id,
  title: t.title,
  number: t.number,
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
  queue,
  ...(external ? { external: true } : {}),
});

/**
 * Finish-date odds for one space. Each person's queue is their work here; the caller's own queue
 * also carries their work from other spaces (it takes the same hours), counted but not reported.
 * A teammate's history is read only from what the caller can see in this space.
 */
@Injectable()
export class OddsService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly tasks: TasksService,
    private readonly work: WorkService,
  ) {}

  private queueOf(t: Pick<Task, 'assigneeId' | 'createdBy'>, a: Access): string {
    if (a.kind === 'personal') return a.userId;
    return t.assigneeId ?? UNASSIGNED;
  }

  private async input(auth: AuthContext, a: Access, runs?: number): Promise<{ input: OddsInput; mine: Calibration; external: number }> {
    const [active, deps, spaces] = await Promise.all([this.tasks.listActive(a), this.tasks.dependencies(a), this.work.spaces(auth)]);
    const others = spaces.filter((s) => s.a.workspaceId !== a.workspaceId);
    const elsewhere = (await this.work.active(others)).flatMap((x) => x.tasks);
    const mine = await this.work.calibration(auth.user, spaces.map((s) => s.a), true);

    const tasks = active.map((t) => oddsTask(t, this.queueOf(t, a)));
    const people = new Map<string, OddsPerson>();
    people.set(auth.user.id, { hours: workHoursOf(auth.user.workHours), calibration: mine });
    const teammates = [...new Set(tasks.map((t) => t.queue))].filter((q) => q !== auth.user.id && q !== UNASSIGNED);
    if (teammates.length) {
      const rows = await this.db.query.users.findMany({ where: inArray(users.id, teammates) });
      await Promise.all(
        rows.map(async (u) => people.set(u.id, { hours: workHoursOf(u.workHours), calibration: await this.work.calibration(u, [a], false) })),
      );
    }
    // Unassigned work: nobody's hours in particular, so the defaults and no history.
    people.set(UNASSIGNED, { hours: workHoursOf(null), calibration: NO_HISTORY });
    const now = nowIn(auth.user.timezone);
    return {
      input: {
        today: now.date,
        nowMinutes: now.minutes,
        tasks: [...tasks, ...elsewhere.map((t) => oddsTask(t, auth.user.id, true))],
        deps,
        people,
        runs,
      },
      mine,
      external: elsewhere.length,
    };
  }

  async forecast(auth: AuthContext, a: Access): Promise<OddsResponse> {
    const { input, mine, external } = await this.input(auth, a);
    return { today: input.today, report: forecastOdds(input), calibration: summarizeCalibration(mine), external };
  }

  /** When could this work be promised, and what would an earlier date cost? */
  async commit(auth: AuthContext, a: Access, body: CommitInput): Promise<CommitResponse> {
    const { input, mine } = await this.input(auth, a);
    let subject;
    if (body.taskId) {
      const task = input.tasks.find((t) => t.id === body.taskId && !t.external);
      if (!task) throw new NotFoundException('진행 중인 작업 중에서 찾을 수 없습니다');
      subject = {
        taskId: task.id,
        title: task.title,
        estimateMinutes: body.estimateMinutes !== undefined ? body.estimateMinutes : task.estimateMinutes,
        projectId: task.projectId,
        queue: task.queue,
        priority: body.priority ?? task.priority,
        blockedBy: input.deps.filter((d) => d.taskId === task.id).map((d) => d.dependsOnId),
        startDate: body.startDate !== undefined ? body.startDate : task.startDate,
      };
    } else {
      if (!body.title?.trim() && body.estimateMinutes == null) throw new BadRequestException('무엇을 약속할지(제목이나 예상 시간)를 알려 주세요');
      const ids = new Set(input.tasks.filter((t) => !t.external).map((t) => t.id));
      const blockedBy = (body.blockedBy ?? []).filter((id) => ids.has(id));
      if (blockedBy.length !== (body.blockedBy ?? []).length) throw new BadRequestException('선행 작업은 이 공간의 진행 중인 작업이어야 합니다');
      const assignee = a.kind === 'personal' ? a.userId : (body.assigneeId ?? a.userId);
      subject = {
        title: body.title?.trim() || '새 작업',
        estimateMinutes: body.estimateMinutes ?? null,
        projectId: body.projectId ?? null,
        queue: assignee,
        priority: body.priority ?? 0,
        blockedBy,
        startDate: body.startDate ?? null,
      };
    }
    const person = input.people.get(subject.queue);
    if (!person && subject.queue !== UNASSIGNED) {
      const u = await this.db.query.users.findFirst({ where: inArray(users.id, [subject.queue]) });
      if (u) (input.people as Map<string, OddsPerson>).set(u.id, { hours: workHoursOf(u.workHours), calibration: await this.work.calibration(u, [a], false) });
    }
    const cal = input.people.get(subject.queue)?.calibration ?? mine;
    const report = commitOdds(input, subject, { confidence: body.confidence, date: body.date });
    return {
      today: input.today,
      report,
      minutes: subject.estimateMinutes ?? cal.defaultEstimate,
      estimated: subject.estimateMinutes != null,
    };
  }

  /** The caller's calibration alone (settings screen). */
  async calibration(auth: AuthContext) {
    const spaces = await this.work.spaces(auth);
    return summarizeCalibration(await this.work.calibration(auth.user, spaces.map((s) => s.a), true));
  }

  today(auth: AuthContext) {
    return todayIn(auth.user.timezone);
  }
}
