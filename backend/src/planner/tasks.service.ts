import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  addDays,
  atLeast,
  canEditTask,
  compareDone,
  compareTasks,
  inOverview,
  matchesView,
  OVERVIEW_DAYS,
  OVERVIEW_FIXED_DAYS,
  wouldCreateCycle,
  type BulkCreateTasksInput,
  type CreateTaskInput,
  type Dependency,
  type ISODate,
  type OverviewProject,
  type OverviewTask,
  type ProjectColor,
  type ReorderTasksInput,
  type RescheduleInput,
  type Task,
  type TaskStatus,
  type UpdateTaskInput,
  type ViewName,
} from '@obelisk/core';
import { and, desc, eq, gte, ilike, inArray, isNull, or, sql } from 'drizzle-orm';
import { InjectDb, type Db } from '../db/db.module';
import { projects, taskDependencies, tasks, users, workspaces, type TaskRow } from '../db/schema';
import { AccessService, type Access, type Conn } from '../workspace/access.service';
import { ActivityService } from '../workspace/activity.service';
import { toTask } from './mappers';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTIVE: TaskStatus[] = ['todo', 'doing'];
/** Fields whose before → after is kept in the activity log. Notes are only flagged as changed. */
const LOGGED = ['title', 'status', 'priority', 'startDate', 'dueDate', 'fixed'] as const;

export interface TaskFilter {
  view?: ViewName;
  projectId?: string | null;
  status?: TaskStatus;
  query?: string;
  from?: ISODate;
  to?: ISODate;
  limit?: number;
  /** A user id, or null for unassigned tasks. */
  assigneeId?: string | null;
}

export const taskSubject = (t: { number: number; title: string }) => `#${t.number} ${t.title}`;

@Injectable()
export class TasksService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly access: AccessService,
    private readonly activity: ActivityService,
  ) {}

  // ───────────────────────────── reads

  private async row(a: Access, id: string, conn: Conn = this.db): Promise<TaskRow> {
    const row = await conn.query.tasks.findFirst({ where: and(eq(tasks.id, id), eq(tasks.workspaceId, a.workspaceId)) });
    // Tasks you can't see answer exactly like tasks that don't exist.
    if (!row || !a.taskLevel(row)) throw new NotFoundException('작업을 찾을 수 없습니다');
    return row;
  }

  private async editableRow(a: Access, id: string, conn: Conn = this.db): Promise<TaskRow> {
    const row = await this.row(a, id, conn);
    a.assertTaskEditable(row);
    return row;
  }

  async get(a: Access, id: string, conn: Conn = this.db): Promise<Task> {
    return toTask(await this.row(a, id, conn));
  }

  /** "#12", "12", a uuid, or an unambiguous piece of the title — among tasks the caller can see. */
  async resolve(a: Access, ref: string): Promise<Task> {
    const s = String(ref).trim();
    const scope = a.taskScope();
    let row: TaskRow | undefined;
    if (/^#?\d+$/.test(s)) {
      row = await this.db.query.tasks.findFirst({ where: and(scope, eq(tasks.number, Number(s.replace('#', '')))) });
    } else if (UUID_RE.test(s)) {
      row = await this.db.query.tasks.findFirst({ where: and(scope, eq(tasks.id, s)) });
    } else if (s) {
      const pattern = `%${s.replace(/[%_\\]/g, '\\$&')}%`;
      const rows = await this.db
        .select()
        .from(tasks)
        .where(and(scope, ilike(tasks.title, pattern)))
        .orderBy(sql`case when ${tasks.status} in ('todo','doing') then 0 else 1 end`, desc(tasks.updatedAt))
        .limit(6);
      const exact = rows.filter((r) => r.title.toLowerCase() === s.toLowerCase());
      const active = rows.filter((r) => ACTIVE.includes(r.status));
      if (exact.length === 1) row = exact[0];
      else if (rows.length === 1) row = rows[0];
      else if (active.length === 1) row = active[0];
      else if (rows.length > 1) {
        throw new BadRequestException(`"${s}"에 해당하는 작업이 여러 개입니다: ${rows.map(taskSubject).join(', ')}`);
      }
    }
    if (!row) throw new NotFoundException(`작업 "${s}"를 찾을 수 없습니다`);
    return toTask(row);
  }

  /** Active tasks plus everything finished in the last `recentDays`. */
  async listForClient(a: Access, recentDays = 30): Promise<Task[]> {
    const since = new Date(Date.now() - recentDays * 86_400_000);
    const rows = await this.db
      .select()
      .from(tasks)
      .where(and(a.taskScope(), or(inArray(tasks.status, ACTIVE), gte(tasks.updatedAt, since))));
    return rows.map(toTask);
  }

  async listActive(a: Access, conn: Conn = this.db): Promise<Task[]> {
    const rows = await conn
      .select()
      .from(tasks)
      .where(and(a.taskScope(), inArray(tasks.status, ACTIVE)));
    return rows.map(toTask);
  }

  async list(a: Access, f: TaskFilter, today: ISODate): Promise<Task[]> {
    const wantsClosed = f.view === 'done' || f.status === 'done' || f.status === 'canceled';
    const conds = [a.taskScope()];
    if (!wantsClosed) conds.push(inArray(tasks.status, ACTIVE));
    else conds.push(inArray(tasks.status, f.status === 'canceled' ? ['canceled'] : ['done']));
    if (f.projectId !== undefined) {
      conds.push(f.projectId === null ? isNull(tasks.projectId) : eq(tasks.projectId, f.projectId));
    }
    if (f.assigneeId !== undefined) {
      conds.push(f.assigneeId === null ? isNull(tasks.assigneeId) : eq(tasks.assigneeId, f.assigneeId));
    }
    if (f.status) conds.push(eq(tasks.status, f.status));
    if (f.query) {
      const p = `%${f.query.replace(/[%_\\]/g, '\\$&')}%`;
      conds.push(or(ilike(tasks.title, p), ilike(tasks.notes, p))!);
    }
    const rows = await this.db
      .select()
      .from(tasks)
      .where(and(...conds))
      .orderBy(desc(tasks.completedAt))
      .limit(wantsClosed ? Math.min(f.limit ?? 50, 500) : 5000);

    let out = rows.map(toTask);
    if (f.view && f.view !== 'done') out = out.filter((t) => matchesView(t, f.view!, today));
    if (f.from || f.to) {
      out = out.filter((t) => {
        const s = t.startDate ?? t.dueDate;
        const e = t.dueDate ?? t.startDate;
        if (!s || !e) return false;
        return (!f.to || s <= f.to) && (!f.from || e >= f.from);
      });
    }
    out.sort(wantsClosed ? compareDone : compareTasks);
    return out.slice(0, Math.min(f.limit ?? 200, 1000));
  }

  /**
   * 모아보기 rows for one space: the caller's own work (all of a personal space, what is assigned to
   * them in an organization) that is overdue, due soon, in progress or a fixed date within the horizon.
   * Visibility is the usual taskScope, so a task assigned to them in a project they can't see stays hidden.
   */
  async overview(a: Access, today: ISODate): Promise<{ tasks: OverviewTask[]; projects: OverviewProject[] }> {
    const until = addDays(today, Math.max(OVERVIEW_DAYS, OVERVIEW_FIXED_DAYS));
    const conds = [
      a.taskScope(),
      inArray(tasks.status, ACTIVE),
      // Earliest date within the horizon (start <= due), or in progress whatever its dates.
      or(eq(tasks.status, 'doing'), sql`coalesce(${tasks.startDate}, ${tasks.dueDate}) <= ${until}`)!,
    ];
    if (a.kind === 'org') conds.push(eq(tasks.assigneeId, a.userId));
    const rows = await this.db
      .select()
      .from(tasks)
      .where(and(...conds));
    const list = rows.map(toTask).filter((t) => inOverview(t, a.kind, a.userId, today));
    const ids = [...new Set(list.map((t) => t.projectId).filter((id): id is string => !!id))];
    const projectRows = ids.length
      ? await this.db
          .select({ id: projects.id, workspaceId: projects.workspaceId, name: projects.name, color: projects.color })
          .from(projects)
          .where(inArray(projects.id, ids))
      : [];
    return {
      tasks: list.map((t) => ({ ...t, editable: canEditTask(t, a) })),
      projects: projectRows.map((p) => ({ ...p, color: p.color as ProjectColor })),
    };
  }

  /** Links between tasks the caller can both see. Hidden tasks leave no trace. */
  async dependencies(a: Access, conn: Conn = this.db): Promise<Dependency[]> {
    const base = conn
      .select({ taskId: taskDependencies.taskId, dependsOnId: taskDependencies.dependsOnId })
      .from(taskDependencies)
      .$dynamic();
    if (a.kind === 'personal') return base.where(eq(taskDependencies.workspaceId, a.workspaceId));
    const visible = conn.select({ id: tasks.id }).from(tasks).where(a.taskScope());
    return base.where(
      and(
        eq(taskDependencies.workspaceId, a.workspaceId),
        inArray(taskDependencies.taskId, visible),
        inArray(taskDependencies.dependsOnId, visible),
      ),
    );
  }

  // ───────────────────────────── permission helpers

  /** Writing into a project needs "edit" there; the inbox is always yours. */
  private assertProjectWritable(a: Access, projectId: string | null | undefined) {
    if (!projectId) return;
    a.assertProject(projectId, 'edit');
  }

  /**
   * An assignee must belong to the workspace and be able to see the task: in a project,
   * at least "view" there. In a personal space you can only assign yourself.
   */
  private async assertAssignee(conn: Conn, a: Access, assigneeId: string | null | undefined, projectId: string | null) {
    if (!assigneeId || assigneeId === a.userId) return;
    if (a.kind === 'personal') throw new BadRequestException('개인 공간에서는 담당자를 자기 자신으로만 지정할 수 있습니다');
    const member = await this.access.membership(a.workspaceId, assigneeId, conn);
    const user = member ? await conn.query.users.findFirst({ where: eq(users.id, assigneeId) }) : undefined;
    if (!member || !user) throw new BadRequestException('담당자는 이 조직의 멤버여야 합니다');
    if (projectId && !atLeast(await this.access.userLevel(a.workspaceId, assigneeId, projectId, conn), 'view')) {
      throw new BadRequestException(`${user.name}님은 이 프로젝트를 볼 수 없어 담당자로 지정할 수 없습니다. 먼저 프로젝트를 공유하세요.`);
    }
  }

  private async nextNumber(conn: Conn, workspaceId: string): Promise<number> {
    const [row] = await conn
      .update(workspaces)
      .set({ taskSeq: sql`${workspaces.taskSeq} + 1` })
      .where(eq(workspaces.id, workspaceId))
      .returning({ seq: workspaces.taskSeq });
    return row!.seq;
  }

  private async names(conn: Conn, ids: { projects?: (string | null)[]; users?: (string | null)[] }) {
    const pIds = [...new Set((ids.projects ?? []).filter(Boolean) as string[])];
    const uIds = [...new Set((ids.users ?? []).filter(Boolean) as string[])];
    const [ps, us] = await Promise.all([
      pIds.length ? conn.select({ id: projects.id, name: projects.name }).from(projects).where(inArray(projects.id, pIds)) : [],
      uIds.length ? conn.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, uIds)) : [],
    ]);
    const map = new Map<string, string>([...ps, ...us].map((r) => [r.id, r.name]));
    return (id: string | null | undefined) => (id ? (map.get(id) ?? null) : null);
  }

  /** before → after for the activity log, with names for project and assignee. */
  private async changes(conn: Conn, cur: TaskRow, next: TaskRow) {
    const out: Record<string, unknown> = {};
    for (const f of LOGGED) {
      if (JSON.stringify(cur[f]) !== JSON.stringify(next[f])) out[f] = { from: cur[f], to: next[f] };
    }
    if (cur.notes !== next.notes) out.notes = true;
    if (cur.projectId !== next.projectId || cur.assigneeId !== next.assigneeId) {
      const name = await this.names(conn, { projects: [cur.projectId, next.projectId], users: [cur.assigneeId, next.assigneeId] });
      if (cur.projectId !== next.projectId) out.project = { from: name(cur.projectId), to: name(next.projectId) };
      if (cur.assigneeId !== next.assigneeId) {
        out.assignee = { from: name(cur.assigneeId), to: name(next.assigneeId), fromId: cur.assigneeId, toId: next.assigneeId };
      }
    }
    return out;
  }

  // ───────────────────────────── writes

  private async insertTask(tx: Tx, a: Access, input: Omit<CreateTaskInput, 'blockedBy'>): Promise<TaskRow> {
    const projectId = input.projectId ?? null;
    if (projectId) await this.projectInWorkspace(tx, a, projectId);
    this.assertProjectWritable(a, projectId);
    await this.assertAssignee(tx, a, input.assigneeId, projectId);
    const number = await this.nextNumber(tx, a.workspaceId);
    const status = input.status ?? 'todo';
    const [row] = await tx
      .insert(tasks)
      .values({
        workspaceId: a.workspaceId,
        createdBy: a.userId,
        assigneeId: input.assigneeId ?? null,
        number,
        title: input.title,
        notes: input.notes ?? '',
        status,
        priority: input.priority ?? 0,
        projectId,
        startDate: input.startDate ?? null,
        dueDate: input.dueDate ?? null,
        fixed: input.fixed ?? false,
        position: Date.now() / 1000,
        completedAt: status === 'done' ? new Date() : null,
      })
      .returning();
    await this.activity.record(tx, a, {
      action: 'task.created',
      taskId: row!.id,
      projectId,
      subject: taskSubject(row!),
      ...(row!.assigneeId && row!.assigneeId !== a.userId
        ? { data: { assignee: (await this.names(tx, { users: [row!.assigneeId] }))(row!.assigneeId) } }
        : {}),
    });
    return row!;
  }

  private async projectInWorkspace(conn: Conn, a: Access, projectId: string) {
    const p = await conn.query.projects.findFirst({
      where: and(eq(projects.id, projectId), eq(projects.workspaceId, a.workspaceId)),
      columns: { id: true },
    });
    if (!p || !a.projectLevel(p.id)) throw new BadRequestException('존재하지 않는 프로젝트입니다');
  }

  async create(a: Access, input: CreateTaskInput): Promise<Task> {
    if (input.startDate && input.dueDate && input.startDate > input.dueDate) {
      throw new BadRequestException('시작일은 마감일보다 늦을 수 없습니다');
    }
    return this.db.transaction(async (tx) => {
      const row = await this.insertTask(tx, a, input);
      for (const dep of new Set(input.blockedBy ?? [])) {
        await this.row(a, dep, tx);
        await tx
          .insert(taskDependencies)
          .values({ taskId: row.id, dependsOnId: dep, workspaceId: a.workspaceId })
          .onConflictDoNothing();
      }
      return toTask(row);
    });
  }

  /**
   * Create a batch of tasks in one go, wiring dependencies by in-batch `key`
   * or by existing task ref (#number / uuid). Ideal for AI-generated plans.
   */
  async createMany(a: Access, input: BulkCreateTasksInput) {
    return this.db.transaction(async (tx) => {
      const keyToId = new Map<string, string>();
      const created: TaskRow[] = [];
      for (const item of input.tasks) {
        if (item.startDate && item.dueDate && item.startDate > item.dueDate) {
          throw new BadRequestException(`"${item.title}": 시작일은 마감일보다 늦을 수 없습니다`);
        }
        const row = await this.insertTask(tx, a, { ...item, projectId: item.projectId ?? input.projectId });
        created.push(row);
        if (item.key) keyToId.set(item.key, row.id);
      }
      const deps = await this.dependencies(a, tx);
      const added: Dependency[] = [];
      for (const [i, item] of input.tasks.entries()) {
        for (const ref of item.blockedBy ?? []) {
          const dependsOnId = keyToId.get(ref) ?? (await this.resolveIn(tx, a, ref));
          const taskId = created[i]!.id;
          if (wouldCreateCycle(deps, taskId, dependsOnId)) {
            throw new BadRequestException(`"${item.title}" → "${ref}" 의존성이 순환을 만듭니다`);
          }
          deps.push({ taskId, dependsOnId });
          added.push({ taskId, dependsOnId });
          await tx.insert(taskDependencies).values({ taskId, dependsOnId, workspaceId: a.workspaceId }).onConflictDoNothing();
        }
      }
      return { tasks: created.map(toTask), dependencies: added };
    });
  }

  private async resolveIn(conn: Conn, a: Access, ref: string): Promise<string> {
    const s = ref.trim();
    const scope = a.taskScope();
    const row = /^#?\d+$/.test(s)
      ? await conn.query.tasks.findFirst({ where: and(scope, eq(tasks.number, Number(s.replace('#', '')))) })
      : UUID_RE.test(s)
        ? await conn.query.tasks.findFirst({ where: and(scope, eq(tasks.id, s)) })
        : undefined;
    if (!row) throw new BadRequestException(`blockedBy "${ref}"를 찾을 수 없습니다 (배치 내 key, #번호, id 중 하나)`);
    return row.id;
  }

  async update(a: Access, id: string, patch: UpdateTaskInput, conn: Conn = this.db): Promise<Task> {
    const cur = await this.editableRow(a, id, conn);
    const start = patch.startDate !== undefined ? patch.startDate : cur.startDate;
    const due = patch.dueDate !== undefined ? patch.dueDate : cur.dueDate;
    if (start && due && start > due) throw new BadRequestException('시작일은 마감일보다 늦을 수 없습니다');
    const projectId = patch.projectId !== undefined ? patch.projectId : cur.projectId;
    if (patch.projectId !== undefined && patch.projectId !== cur.projectId) {
      if (patch.projectId) await this.projectInWorkspace(conn, a, patch.projectId);
      this.assertProjectWritable(a, patch.projectId);
    }
    const assigneeId = patch.assigneeId !== undefined ? patch.assigneeId : cur.assigneeId;
    if (assigneeId !== cur.assigneeId || projectId !== cur.projectId) {
      await this.assertAssignee(conn, a, assigneeId, projectId);
    }

    const set: Partial<TaskRow> = { ...patch, updatedAt: new Date() } as Partial<TaskRow>;
    if (patch.status && patch.status !== cur.status) {
      set.completedAt = patch.status === 'done' ? new Date() : null;
    }
    if (cur.dueDate && due && due > cur.dueDate) set.postponedCount = cur.postponedCount + 1;
    const onlyPosition = Object.keys(patch).every((k) => k === 'position');
    if (onlyPosition) delete set.updatedAt;

    const [row] = await conn
      .update(tasks)
      .set(set)
      .where(and(eq(tasks.id, id), eq(tasks.workspaceId, a.workspaceId)))
      .returning();
    const changes = await this.changes(conn, cur, row!);
    if (Object.keys(changes).length) {
      await this.activity.record(conn, a, {
        action: 'task.updated',
        taskId: id,
        projectId: row!.projectId,
        subject: taskSubject(row!),
        data: { changes },
      });
    }
    return toTask(row!);
  }

  async reschedule(a: Access, input: RescheduleInput): Promise<Task[]> {
    return this.db.transaction(async (tx) => {
      const out: Task[] = [];
      // Check everything first: one view-only task in a cascade cancels the whole move.
      const rows = new Map<string, TaskRow>();
      for (const c of input.changes) rows.set(c.taskId, await this.editableRow(a, c.taskId, tx));
      const root = input.rootId ? rows.get(input.rootId) : undefined;
      for (const c of input.changes) {
        if (c.startDate && c.dueDate && c.startDate > c.dueDate) {
          throw new BadRequestException('시작일은 마감일보다 늦을 수 없습니다');
        }
        const cur = rows.get(c.taskId)!;
        const later = !!(cur.dueDate && c.dueDate && c.dueDate > cur.dueDate);
        const [row] = await tx
          .update(tasks)
          .set({
            startDate: c.startDate,
            dueDate: c.dueDate,
            updatedAt: new Date(),
            ...(later && c.taskId === input.rootId ? { postponedCount: cur.postponedCount + 1 } : {}),
          })
          .where(and(eq(tasks.id, c.taskId), eq(tasks.workspaceId, a.workspaceId)))
          .returning();
        const changes = await this.changes(tx, cur, row!);
        if (Object.keys(changes).length) {
          await this.activity.record(tx, a, {
            action: 'task.updated',
            taskId: c.taskId,
            projectId: row!.projectId,
            subject: taskSubject(row!),
            data: { changes, ...(root && root.id !== c.taskId ? { cause: taskSubject(root), causeId: root.id } : {}) },
          });
        }
        out.push(toTask(row!));
      }
      return out;
    });
  }

  /**
   * Board moves: new manual positions (and, for a card dropped in another column, its new status),
   * applied atomically. Position-only changes leave `updatedAt` alone — reordering isn't an edit.
   */
  async reorder(a: Access, input: ReorderTasksInput): Promise<Task[]> {
    return this.db.transaction(async (tx) => {
      const out: Task[] = [];
      for (const c of input.changes) {
        if (c.status) {
          out.push(await this.update(a, c.taskId, { status: c.status, position: c.position }, tx));
          continue;
        }
        await this.editableRow(a, c.taskId, tx);
        const [row] = await tx
          .update(tasks)
          .set({ position: c.position })
          .where(and(eq(tasks.id, c.taskId), eq(tasks.workspaceId, a.workspaceId)))
          .returning();
        if (!row) throw new NotFoundException('작업을 찾을 수 없습니다');
        out.push(toTask(row));
      }
      return out;
    });
  }

  async remove(a: Access, id: string) {
    const cur = await this.editableRow(a, id);
    await this.db.transaction(async (tx) => {
      await tx.delete(tasks).where(and(eq(tasks.id, id), eq(tasks.workspaceId, a.workspaceId)));
      await this.activity.record(tx, a, { action: 'task.deleted', taskId: id, projectId: cur.projectId, subject: taskSubject(cur) });
    });
    return { ok: true };
  }

  /** Linking needs "edit" on the task that waits, and the ability to see the one it waits for. */
  async addDependency(a: Access, taskId: string, dependsOnId: string): Promise<Dependency> {
    const task = await this.editableRow(a, taskId);
    const blocker = await this.row(a, dependsOnId);
    const deps = await this.dependencies(a);
    if (wouldCreateCycle(deps, taskId, dependsOnId)) {
      throw new BadRequestException('순환 의존성은 만들 수 없습니다 (서로가 서로를 기다리게 됩니다)');
    }
    await this.db.transaction(async (tx) => {
      const added = await tx
        .insert(taskDependencies)
        .values({ taskId, dependsOnId, workspaceId: a.workspaceId })
        .onConflictDoNothing()
        .returning();
      if (added.length) {
        await this.activity.record(tx, a, {
          action: 'dependency.added',
          taskId,
          projectId: task.projectId,
          subject: taskSubject(task),
          data: { blockedBy: taskSubject(blocker), blockedById: blocker.id },
        });
      }
    });
    return { taskId, dependsOnId };
  }

  async removeDependency(a: Access, taskId: string, dependsOnId: string) {
    const task = await this.editableRow(a, taskId);
    await this.db.transaction(async (tx) => {
      const removed = await tx
        .delete(taskDependencies)
        .where(
          and(
            eq(taskDependencies.workspaceId, a.workspaceId),
            eq(taskDependencies.taskId, taskId),
            eq(taskDependencies.dependsOnId, dependsOnId),
          ),
        )
        .returning();
      if (removed.length) {
        const blocker = await tx.query.tasks.findFirst({ where: eq(tasks.id, dependsOnId) });
        await this.activity.record(tx, a, {
          action: 'dependency.removed',
          taskId,
          projectId: task.projectId,
          subject: taskSubject(task),
          data: { blockedBy: blocker ? taskSubject(blocker) : null, blockedById: dependsOnId },
        });
      }
    });
    return { ok: true };
  }
}
