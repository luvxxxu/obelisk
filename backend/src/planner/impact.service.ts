import { BadRequestException, Injectable } from '@nestjs/common';
import {
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
import { toPlanItem, toTask } from './mappers';
import { TasksService } from './tasks.service';

@Injectable()
export class ImpactService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly tasks: TasksService,
  ) {}

  private async plan(userId: string) {
    const [active, deps] = await Promise.all([this.tasks.listActive(userId), this.tasks.dependencies(userId)]);
    return { active, items: active.map(toPlanItem), deps };
  }

  private assertMovable(task: Task) {
    if (!isActive(task)) throw new BadRequestException('완료되었거나 취소된 작업은 미룰 수 없습니다');
    if (!task.startDate && !task.dueDate) {
      throw new BadRequestException('날짜(시작일/마감일)가 없는 작업은 미룰 수 없습니다. 먼저 마감일을 지정하세요.');
    }
  }

  async simulate(userId: string, input: DelayInput): Promise<{ task: Task; days: number; report: ImpactReport }> {
    const task = await this.tasks.get(userId, input.taskId);
    this.assertMovable(task);
    const { items, deps } = await this.plan(userId);
    const days = resolveDelayDays(task, input);
    return { task, days, report: simulate(items, deps, { [task.id]: days }) };
  }

  /** Move a task (and, with `cascade`, everything its delay pushes) in one transaction. */
  async postpone(userId: string, input: PostponeInput) {
    const { task, days, report } = await this.simulate(userId, input);
    const changes = changesFromReport(report, input.cascade);
    const updated = await this.db.transaction(async (tx) => {
      const out: Task[] = [];
      for (const c of changes) {
        const isRoot = c.taskId === task.id;
        const [row] = await tx
          .update(tasks)
          .set({
            startDate: c.startDate,
            dueDate: c.dueDate,
            updatedAt: new Date(),
            ...(isRoot && days > 0 ? { postponedCount: sql`${tasks.postponedCount} + 1` } : {}),
          })
          .where(and(eq(tasks.id, c.taskId), eq(tasks.userId, userId)))
          .returning();
        if (row) out.push(toTask(row));
      }
      return out;
    });
    return { task: updated.find((t) => t.id === task.id) ?? task, days, cascade: input.cascade, report, updated };
  }

  async forecast(userId: string, timezone: string) {
    const today = todayIn(timezone);
    const { items, deps } = await this.plan(userId);
    return { today, report: forecast(items, deps, today) };
  }

  async leverage(userId: string) {
    const { items, deps } = await this.plan(userId);
    return leverage(items, deps);
  }
}
