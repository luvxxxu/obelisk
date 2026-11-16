import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import {
  canEditTask,
  changesFromReport,
  forecast,
  isActive,
  leverage,
  resolveDelayDays,
  simulate,
  todayIn,
  type DelayInput,
  type ImpactReport,
  type PostponeInput,
  type Task,
} from '@obelisk/core';
import { and, eq, sql } from 'drizzle-orm';
import { InjectDb, type Db } from '../db/db.module';
import { tasks } from '../db/schema';
import type { Access } from '../workspace/access.service';
import { ActivityService } from '../workspace/activity.service';
import { toPlanItem, toTask } from './mappers';
import { taskSubject, TasksService } from './tasks.service';

@Injectable()
export class ImpactService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly tasks: TasksService,
    private readonly activity: ActivityService,
  ) {}

  /** The plan as the caller sees it: hidden tasks and their links are not part of it. */
  private async plan(a: Access) {
    const [active, deps] = await Promise.all([this.tasks.listActive(a), this.tasks.dependencies(a)]);
    return { active, items: active.map(toPlanItem), deps };
  }

  private assertMovable(task: Task) {
    if (!isActive(task)) throw new BadRequestException('완료되었거나 취소된 작업은 미룰 수 없습니다');
    if (!task.startDate && !task.dueDate) {
      throw new BadRequestException('날짜(시작일/마감일)가 없는 작업은 미룰 수 없습니다. 먼저 마감일을 지정하세요.');
    }
  }

  async simulate(a: Access, input: DelayInput): Promise<{ task: Task; days: number; report: ImpactReport }> {
    const task = await this.tasks.get(a, input.taskId);
    this.assertMovable(task);
    const { items, deps } = await this.plan(a);
    const days = resolveDelayDays(task, input);
    return { task, days, report: simulate(items, deps, { [task.id]: days }) };
  }

  /**
   * Move a task (and, with `cascade`, everything its delay pushes) in one transaction.
   * Every task that would move needs "edit": a cascade that reaches a view-only task is
   * refused as a whole rather than half-applied.
   */
  async postpone(a: Access, input: PostponeInput) {
    const { task, days, report } = await this.simulate(a, input);
    a.assertTaskEditable(task);
    const changes = changesFromReport(report, input.cascade);
    const all = await this.tasks.listActive(a);
    const byId = new Map(all.map((t) => [t.id, t]));
    const blocked = changes.map((c) => byId.get(c.taskId)).filter((t): t is Task => !!t && !canEditTask(t, a));
    if (blocked.length) {
      throw new ForbiddenException(
        `연쇄로 밀리는 작업 중 ${blocked.map(taskSubject).join(', ')}에 쓰기 권한이 없어 함께 옮길 수 없습니다. ` +
          '연쇄 없이(cascade=false) 이 작업만 미루거나, 프로젝트 관리자에게 쓰기 권한을 요청하세요.',
      );
    }
    const updated = await this.db.transaction(async (tx) => {
      const out: Task[] = [];
      for (const c of changes) {
        const isRoot = c.taskId === task.id;
        const before = byId.get(c.taskId);
        const [row] = await tx
          .update(tasks)
          .set({
            startDate: c.startDate,
            dueDate: c.dueDate,
            updatedAt: new Date(),
            ...(isRoot && days > 0 ? { postponedCount: sql`${tasks.postponedCount} + 1` } : {}),
          })
          .where(and(eq(tasks.id, c.taskId), eq(tasks.workspaceId, a.workspaceId)))
          .returning();
        if (!row) continue;
        out.push(toTask(row));
        const dates = {
          startDate: { from: before?.startDate ?? null, to: row.startDate },
          dueDate: { from: before?.dueDate ?? null, to: row.dueDate },
        };
        await this.activity.record(tx, a, {
          action: isRoot ? 'task.postponed' : 'task.updated',
          taskId: row.id,
          projectId: row.projectId,
          subject: taskSubject(row),
          data: isRoot
            ? { days, cascade: input.cascade, moved: changes.length - 1, changes: dates }
            : { changes: dates, cause: taskSubject(task), causeId: task.id },
        });
      }
      return out;
    });
    return { task: updated.find((t) => t.id === task.id) ?? task, days, cascade: input.cascade, report, updated };
  }

  async forecast(a: Access) {
    const today = todayIn(a.user.timezone);
    const { items, deps } = await this.plan(a);
    return { today, report: forecast(items, deps, today) };
  }

  async leverage(a: Access) {
    const { items, deps } = await this.plan(a);
    return leverage(items, deps);
  }
}
