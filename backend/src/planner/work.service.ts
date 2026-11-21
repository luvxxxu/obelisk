import { Injectable } from '@nestjs/common';
import {
  calibrate,
  canEditTask,
  todayIn,
  workHoursOf,
  type Calibration,
  type Dependency,
  type OverviewProject,
  type OverviewTask,
  type ProjectColor,
  type Task,
  type WorkspaceSummary,
} from '@obelisk/core';
import { and, desc, eq, gte, inArray, or, type SQL } from 'drizzle-orm';
import { hasAssignee, unassigned } from './assignees';
import type { AuthContext } from '../auth/auth.service';
import { InjectDb, type Db } from '../db/db.module';
import { projects, tasks } from '../db/schema';
import { AccessService, type Access } from '../workspace/access.service';
import { WorkspacesService } from '../workspace/workspaces.service';
import { toTask } from './mappers';
import { TimeService } from './time.service';
import { TasksService } from './tasks.service';

export interface Space {
  summary: WorkspaceSummary;
  a: Access;
}

/** How far back finished work teaches the odds. */
const HISTORY_DAYS = 120;

/**
 * A person's own work across every space they belong to, read with each space's permissions:
 * all of a personal space, and in an organization what is assigned to them (or unassigned work
 * they created). Day plans and the load side of finish-date odds are built from this.
 */
@Injectable()
export class WorkService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly access: AccessService,
    private readonly workspaces: WorkspacesService,
    private readonly tasks: TasksService,
    private readonly time: TimeService,
  ) {}

  async spaces(auth: AuthContext): Promise<Space[]> {
    const list = await this.workspaces.listFor(auth.user.id);
    return Promise.all(list.map(async (summary) => ({ summary, a: await this.access.forWorkspace(auth, summary.id) })));
  }

  /** SQL for "mine" in a space. */
  mineWhere(a: Access): SQL | undefined {
    if (a.kind === 'personal') return undefined;
    return or(hasAssignee(a.userId), and(unassigned(), eq(tasks.createdBy, a.userId)));
  }

  isMine(t: Pick<Task, 'assigneeIds' | 'createdBy'>, a: Access): boolean {
    return a.kind === 'personal' || t.assigneeIds.includes(a.userId) || (!t.assigneeIds.length && t.createdBy === a.userId);
  }

  /** Active work that is mine, per space, with the links between visible tasks. */
  async active(spaces: Space[]): Promise<{ space: Space; tasks: Task[]; deps: Dependency[] }[]> {
    return Promise.all(
      spaces.map(async (space) => {
        const [all, deps] = await Promise.all([this.tasks.listActive(space.a), this.tasks.dependencies(space.a)]);
        return { space, tasks: all.filter((t) => this.isMine(t, space.a)), deps };
      }),
    );
  }

  /**
   * How a person's estimates, days and deadlines usually go, from their finished work. For the
   * caller (`spaces` = all of theirs) it spans every space and includes tracked time; for a teammate
   * it is read from what the caller can see in one space, without their tracked time.
   */
  async calibration(user: { id: string; timezone: string; workHours: unknown }, spaces: Access[], self: boolean): Promise<Calibration> {
    const since = new Date(Date.now() - HISTORY_DAYS * 86_400_000);
    const rows = (
      await Promise.all(
        spaces.map((a) => {
          const whose = self ? this.mineWhere(a) : hasAssignee(user.id);
          return this.db
            .select()
            .from(tasks)
            .where(and(a.taskScope(), eq(tasks.status, 'done'), gte(tasks.completedAt, since), whose))
            .orderBy(desc(tasks.completedAt))
            .limit(300);
        }),
      )
    )
      .flat()
      .sort((x, y) => (y.completedAt?.getTime() ?? 0) - (x.completedAt?.getTime() ?? 0));
    const hours = workHoursOf(user.workHours as never);
    const today = todayIn(user.timezone);
    return calibrate({
      finished: rows.map((r) => ({
        estimateMinutes: r.estimateMinutes,
        actualMinutes: r.actualMinutes,
        firstDueDate: r.firstDueDate,
        completedOn: todayIn(user.timezone, r.completedAt!),
      })),
      trackedPerDay: self ? await this.time.trackedPerDay(user.id, user.timezone) : [],
      today,
      hours,
    });
  }

  /** Tasks by id from any of the spaces, only where the caller can see them. */
  async visibleByIds(spaces: Space[], ids: string[]): Promise<Map<string, OverviewTask>> {
    const out = new Map<string, OverviewTask>();
    const unique = [...new Set(ids)];
    if (!unique.length) return out;
    const rows = await this.db.select().from(tasks).where(inArray(tasks.id, unique));
    for (const r of rows) {
      const space = spaces.find((s) => s.a.workspaceId === r.workspaceId);
      if (!space || !space.a.taskLevel(r)) continue;
      out.set(r.id, this.overviewTask(toTask(r), space.a));
    }
    return out;
  }

  overviewTask(t: Task, a: Access): OverviewTask {
    return { ...t, editable: canEditTask(t, a) };
  }

  async projectsOf(list: Pick<Task, 'projectId'>[]): Promise<OverviewProject[]> {
    const ids = [...new Set(list.map((t) => t.projectId).filter((id): id is string => !!id))];
    if (!ids.length) return [];
    const rows = await this.db
      .select({ id: projects.id, workspaceId: projects.workspaceId, name: projects.name, color: projects.color })
      .from(projects)
      .where(inArray(projects.id, ids));
    return rows.map((p) => ({ ...p, color: p.color as ProjectColor }));
  }
}
