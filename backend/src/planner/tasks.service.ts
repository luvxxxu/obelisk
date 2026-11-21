import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
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
  spanIssues,
  wouldCreateCycle,
  type BulkCreateTasksInput,
  type Clock,
  type CreateTaskInput,
  type Dependency,
  type ISODate,
  type OverviewProject,
  type OverviewTask,
  type ProjectColor,
  type ReorderTasksInput,
  type RescheduleInput,
  type RestoreResult,
  type Task,
  type TaskStatus,
  type TrashItem,
  type UpdateTaskInput,
  type ViewName,
} from '@obelisk/core';
import { and, desc, eq, gte, ilike, inArray, isNull, notInArray, or, sql, type SQL } from 'drizzle-orm';
import { config } from '../config';
import { InjectDb, type Db } from '../db/db.module';
import { projects, taskDependencies, tasks, taskTrash, users, workspaces, type TaskRow, type TaskTrashRow } from '../db/schema';
import { AccessService, type Access, type Conn } from '../workspace/access.service';
import { ActivityService } from '../workspace/activity.service';
import { hasAssignee, sameAssignees, unassigned } from './assignees';
import { toTask } from './mappers';
import { TimeService } from './time.service';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTIVE: TaskStatus[] = ['todo', 'doing'];
/** Fields whose before → after is kept in the activity log. Notes are only flagged as changed. */
const LOGGED = ['title', 'status', 'priority', 'startDate', 'startTime', 'dueDate', 'dueTime', 'fixed', 'estimateMinutes'] as const;

export interface TaskFilter {
  view?: ViewName;
  projectId?: string | null;
  status?: TaskStatus;
  query?: string;
  from?: ISODate;
  to?: ISODate;
  limit?: number;
  /** Tasks this person is among the assignees of, or null for unassigned tasks. */
  assigneeId?: string | null;
}

export const taskSubject = (t: { number: number; title: string }) => `#${t.number} ${t.title}`;

/** Big id lists go to Postgres in pieces (one bind parameter per id). */
function chunks<T>(list: T[], size = 500): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/** Postgres aborted the transaction to break a deadlock (40P01); drizzle may wrap the driver's error. */
function isDeadlock(e: unknown): boolean {
  for (let x: unknown = e, depth = 0; x && typeof x === 'object' && depth < 4; x = (x as { cause?: unknown }).cause, depth++) {
    if ((x as { code?: unknown }).code === '40P01') return true;
  }
  return false;
}

const linkKey = (d: Dependency) => `${d.taskId}>${d.dependsOnId}`;

/** The columns of a trash row that decide who may see and restore it. */
type TrashSubject = Pick<TaskTrashRow, 'projectId' | 'createdBy' | 'assigneeIds' | 'deletedBy'>;

/** Times need their date, and start may not come after due (by date, then by time on the same day). */
function assertSpan(
  v: { startDate?: string | null; startTime?: string | null; dueDate?: string | null; dueTime?: string | null },
  prefix = '',
) {
  const issue = spanIssues(v)[0];
  if (issue) throw new BadRequestException(prefix + issue.message);
}

@Injectable()
export class TasksService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly access: AccessService,
    private readonly activity: ActivityService,
    private readonly time: TimeService,
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

  /** `now` (the user's wall clock) makes the overdue view count a due time that passed today. */
  async list(a: Access, f: TaskFilter, today: ISODate, now?: Clock | null): Promise<Task[]> {
    const wantsClosed = f.view === 'done' || f.status === 'done' || f.status === 'canceled';
    const conds = [a.taskScope()];
    if (!wantsClosed) conds.push(inArray(tasks.status, ACTIVE));
    else conds.push(inArray(tasks.status, f.status === 'canceled' ? ['canceled'] : ['done']));
    if (f.projectId !== undefined) {
      conds.push(f.projectId === null ? isNull(tasks.projectId) : eq(tasks.projectId, f.projectId));
    }
    if (f.assigneeId !== undefined) {
      conds.push(f.assigneeId === null ? unassigned() : hasAssignee(f.assigneeId));
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
    if (f.view && f.view !== 'done') out = out.filter((t) => matchesView(t, f.view!, today, now));
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
    if (a.kind === 'org') conds.push(hasAssignee(a.userId));
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
   * Every assignee must belong to the workspace and be able to see the task: in a project,
   * at least "view" there. In a personal space you can only assign yourself.
   */
  private async assertAssignees(conn: Conn, a: Access, assigneeIds: readonly string[] | undefined, projectId: string | null) {
    for (const id of assigneeIds ?? []) {
      if (id === a.userId) continue;
      if (a.kind === 'personal') throw new BadRequestException('개인 공간에서는 담당자를 자기 자신으로만 지정할 수 있습니다');
      const member = await this.access.membership(a.workspaceId, id, conn);
      const user = member ? await conn.query.users.findFirst({ where: eq(users.id, id) }) : undefined;
      if (!member || !user) throw new BadRequestException('담당자는 이 조직의 멤버여야 합니다');
      if (projectId && !atLeast(await this.access.userLevel(a.workspaceId, id, projectId, conn), 'view')) {
        throw new BadRequestException(`${user.name}님은 이 프로젝트를 볼 수 없어 담당자로 지정할 수 없습니다. 먼저 프로젝트를 공유하세요.`);
      }
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
    const peopleChanged = !sameAssignees(cur.assigneeIds, next.assigneeIds);
    if (cur.projectId !== next.projectId || peopleChanged) {
      const name = await this.names(conn, { projects: [cur.projectId, next.projectId], users: [...cur.assigneeIds, ...next.assigneeIds] });
      if (cur.projectId !== next.projectId) out.project = { from: name(cur.projectId), to: name(next.projectId) };
      if (peopleChanged) {
        const names = (ids: string[]) => ids.map((id) => name(id) ?? '(전 멤버)');
        out.assignees = { from: names(cur.assigneeIds), to: names(next.assigneeIds), fromIds: cur.assigneeIds, toIds: next.assigneeIds };
      }
    }
    return out;
  }

  // ───────────────────────────── writes

  private async insertTask(tx: Tx, a: Access, input: Omit<CreateTaskInput, 'blockedBy'>): Promise<TaskRow> {
    const projectId = input.projectId ?? null;
    if (projectId) await this.projectInWorkspace(tx, a, projectId);
    this.assertProjectWritable(a, projectId);
    await this.assertAssignees(tx, a, input.assigneeIds, projectId);
    const number = await this.nextNumber(tx, a.workspaceId);
    const status = input.status ?? 'todo';
    const [row] = await tx
      .insert(tasks)
      .values({
        workspaceId: a.workspaceId,
        createdBy: a.userId,
        assigneeIds: input.assigneeIds ?? [],
        number,
        title: input.title,
        notes: input.notes ?? '',
        status,
        priority: input.priority ?? 0,
        projectId,
        startDate: input.startDate ?? null,
        startTime: input.startDate ? (input.startTime ?? null) : null,
        dueDate: input.dueDate ?? null,
        dueTime: input.dueDate ? (input.dueTime ?? null) : null,
        fixed: input.fixed ?? false,
        estimateMinutes: input.estimateMinutes ?? null,
        firstDueDate: input.dueDate ?? null,
        position: Date.now() / 1000,
        completedAt: status === 'done' ? new Date() : null,
      })
      .returning();
    if (status === 'doing') await this.time.onStatus(tx, a, row!, 'todo');
    await this.activity.record(tx, a, {
      action: 'task.created',
      taskId: row!.id,
      projectId,
      subject: taskSubject(row!),
      ...(await this.assignedNames(tx, a, row!)),
    });
    return row!;
  }

  /** For task.created: the people it was handed to, besides its maker. */
  private async assignedNames(conn: Conn, a: Access, row: TaskRow): Promise<{ data?: { assignees: string[] } }> {
    const others = row.assigneeIds.filter((id) => id !== a.userId);
    if (!others.length) return {};
    const name = await this.names(conn, { users: others });
    return { data: { assignees: others.map((id) => name(id) ?? '(전 멤버)') } };
  }

  private async projectInWorkspace(conn: Conn, a: Access, projectId: string) {
    const p = await conn.query.projects.findFirst({
      where: and(eq(projects.id, projectId), eq(projects.workspaceId, a.workspaceId)),
      columns: { id: true },
    });
    if (!p || !a.projectLevel(p.id)) throw new BadRequestException('존재하지 않는 프로젝트입니다');
  }

  async create(a: Access, input: CreateTaskInput): Promise<Task> {
    assertSpan(input);
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
        assertSpan(item, `"${item.title}": `);
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
    const { completedAt: doneAt, ...fields } = patch;
    const cur = await this.editableRow(a, id, conn);
    const start = patch.startDate !== undefined ? patch.startDate : cur.startDate;
    const due = patch.dueDate !== undefined ? patch.dueDate : cur.dueDate;
    // A time stays with its date: kept when the date moves, cleared when the date goes.
    const startTime = start ? (patch.startTime !== undefined ? patch.startTime : cur.startTime) : null;
    const dueTime = due ? (patch.dueTime !== undefined ? patch.dueTime : cur.dueTime) : null;
    if (patch.startTime && !start) throw new BadRequestException('시작 시각은 시작일과 함께 정하세요');
    if (patch.dueTime && !due) throw new BadRequestException('마감 시각은 마감일과 함께 정하세요');
    assertSpan({ startDate: start, startTime, dueDate: due, dueTime });
    const projectId = patch.projectId !== undefined ? patch.projectId : cur.projectId;
    if (patch.projectId !== undefined && patch.projectId !== cur.projectId) {
      if (patch.projectId) await this.projectInWorkspace(conn, a, patch.projectId);
      this.assertProjectWritable(a, patch.projectId);
    }
    if (patch.assigneeIds !== undefined || projectId !== cur.projectId) {
      const next = patch.assigneeIds ?? cur.assigneeIds;
      // A new project checks everyone; otherwise only the people being added.
      await this.assertAssignees(conn, a, projectId !== cur.projectId ? next : next.filter((id) => !cur.assigneeIds.includes(id)), projectId);
    }

    const set: Partial<TaskRow> = { ...fields, updatedAt: new Date() } as Partial<TaskRow>;
    if (startTime !== cur.startTime) set.startTime = startTime;
    if (dueTime !== cur.dueTime) set.dueTime = dueTime;
    if (patch.status && patch.status !== cur.status) {
      set.completedAt = patch.status === 'done' ? new Date() : null;
    }
    // A given completion time (an undo putting a task back to done) wins over now, never later than now.
    if ((patch.status ?? cur.status) === 'done' && doneAt) set.completedAt = new Date(Math.min(Date.parse(doneAt), Date.now()));
    if (cur.dueDate && due && due > cur.dueDate) set.postponedCount = cur.postponedCount + 1;
    if (!cur.firstDueDate && due) set.firstDueDate = due;
    const onlyPosition = Object.keys(patch).every((k) => k === 'position');
    if (onlyPosition) delete set.updatedAt;

    let [row] = await conn
      .update(tasks)
      .set(set)
      .where(and(eq(tasks.id, id), eq(tasks.workspaceId, a.workspaceId)))
      .returning();
    // Starting work starts its clock; stopping it records the time (and the task's total).
    if (row!.status !== cur.status && (await this.time.onStatus(conn, a, row!, cur.status))) {
      row = (await conn.query.tasks.findFirst({ where: eq(tasks.id, id) })) ?? row;
    }
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
        const cur = rows.get(c.taskId)!;
        const startTime = c.startDate ? (c.startTime !== undefined ? c.startTime : cur.startTime) : null;
        const dueTime = c.dueDate ? (c.dueTime !== undefined ? c.dueTime : cur.dueTime) : null;
        assertSpan({ startDate: c.startDate, startTime, dueDate: c.dueDate, dueTime });
        const later = !!(cur.dueDate && c.dueDate && c.dueDate > cur.dueDate);
        const [row] = await tx
          .update(tasks)
          .set({
            startDate: c.startDate,
            startTime,
            dueDate: c.dueDate,
            dueTime,
            firstDueDate: cur.firstDueDate ?? c.dueDate,
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
          out.push(await this.update(a, c.taskId, { status: c.status, position: c.position, completedAt: c.completedAt }, tx));
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
    await this.trash(a, [id]);
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

  // ───────────────────────────── trash (휴지통)

  /**
   * Trash rows the caller can see. In an organization: those of projects they can see, plus those
   * whose project is gone (they would land in the inbox) when they made, hold or deleted the task.
   */
  private trashScope(a: Access): SQL {
    const ws = eq(taskTrash.workspaceId, a.workspaceId);
    if (a.kind === 'personal') return ws;
    const here = this.db.select({ id: projects.id }).from(projects).where(eq(projects.workspaceId, a.workspaceId));
    const gone = or(isNull(taskTrash.projectId), notInArray(taskTrash.projectId, here))!;
    const mine = or(eq(taskTrash.createdBy, a.userId), hasAssignee(a.userId, taskTrash.assigneeIds), eq(taskTrash.deletedBy, a.userId))!;
    const orphan = and(gone, mine)!;
    const visible = a.visibleProjectIds();
    return and(ws, visible.length ? or(inArray(taskTrash.projectId, visible), orphan) : orphan)!;
  }

  /** Where a trashed task lands on restore: its project while it is still here, else the inbox. */
  private landing(a: Access, r: Pick<TaskTrashRow, 'projectId'>): string | null {
    return r.projectId && a.projectLevel(r.projectId) ? r.projectId : null;
  }

  /** Restoring (or deleting for good) needs edit where the task lands; in an org inbox the deleter also may. */
  private canRestore(a: Access, r: TrashSubject): boolean {
    const projectId = this.landing(a, r);
    if (!projectId && a.kind === 'org' && r.deletedBy === a.userId) return true;
    return canEditTask({ projectId, createdBy: r.createdBy, assigneeIds: r.assigneeIds }, a);
  }

  /**
   * Moves task rows to the trash: a snapshot with every link touching them first, then the delete
   * (which drops the links by cascade). Callers check permissions and decide what to log.
   */
  async moveToTrash(conn: Conn, a: Access, rows: TaskRow[]): Promise<void> {
    if (!rows.length) return;
    // All links before any delete: a link between two of these rows would be gone by the second chunk.
    const found = new Map<string, Dependency>();
    for (const ids of chunks(rows.map((r) => r.id))) {
      const links = await conn
        .select({ taskId: taskDependencies.taskId, dependsOnId: taskDependencies.dependsOnId })
        .from(taskDependencies)
        .where(
          and(
            eq(taskDependencies.workspaceId, a.workspaceId),
            or(inArray(taskDependencies.taskId, ids), inArray(taskDependencies.dependsOnId, ids)),
          ),
        );
      for (const d of links) found.set(linkKey(d), d);
    }
    const touching = new Map<string, Dependency[]>();
    for (const d of found.values()) {
      for (const id of [d.taskId, d.dependsOnId]) touching.set(id, [...(touching.get(id) ?? []), d]);
    }
    for (const part of chunks(rows)) {
      const ids = part.map((r) => r.id);
      // A leftover row for the same id (restored by hand, say) gives way to the newer snapshot.
      await conn.delete(taskTrash).where(inArray(taskTrash.id, ids));
      await conn.insert(taskTrash).values(
        part.map((r) => ({
          id: r.id,
          workspaceId: a.workspaceId,
          projectId: r.projectId,
          createdBy: r.createdBy,
          assigneeIds: r.assigneeIds,
          deletedBy: a.userId,
          task: toTask(r),
          dependencies: touching.get(r.id) ?? [],
        })),
      );
      await conn.delete(tasks).where(and(eq(tasks.workspaceId, a.workspaceId), inArray(tasks.id, ids)));
    }
  }

  /** Moves tasks to the trash, all or nothing: one missing or view-only task cancels the whole call. */
  async trash(a: Access, ids: string[]): Promise<{ deleted: string[] }> {
    const unique = [...new Set(ids)];
    return this.db.transaction(async (tx) => {
      const found = new Map<string, TaskRow>();
      for (const part of chunks(unique)) {
        // Locked, so a second delete of the same task waits and then finds it gone (404).
        const rows = await tx
          .select()
          .from(tasks)
          .where(and(eq(tasks.workspaceId, a.workspaceId), inArray(tasks.id, part)))
          .for('update');
        for (const r of rows) found.set(r.id, r);
      }
      const rows = unique.map((id) => {
        const r = found.get(id);
        if (!r || !a.taskLevel(r)) throw new NotFoundException('작업을 찾을 수 없습니다');
        a.assertTaskEditable(r);
        return r;
      });
      await this.moveToTrash(tx, a, rows);
      // Logged after the rows are gone, as before the trash existed: webhooks still send task: null.
      for (const r of rows) {
        await this.activity.record(tx, a, { action: 'task.deleted', taskId: r.id, projectId: r.projectId, subject: taskSubject(r) });
      }
      return { deleted: unique };
    });
  }

  /** The workspace the first of these ids was trashed in, so restore links work whichever space is open. */
  async trashWorkspace(ids: string[]): Promise<string | null> {
    for (const part of chunks(ids)) {
      const [row] = await this.db
        .select({ workspaceId: taskTrash.workspaceId })
        .from(taskTrash)
        .where(inArray(taskTrash.id, part))
        .limit(1);
      if (row) return row.workspaceId;
    }
    return null;
  }

  /** The caller's trash in this workspace, newest first. */
  async listTrash(a: Access): Promise<TrashItem[]> {
    const rows = await this.db
      .select({ row: taskTrash, deletedByName: users.name })
      .from(taskTrash)
      .leftJoin(users, eq(users.id, taskTrash.deletedBy))
      .where(this.trashScope(a));
    // A batch shares one deletedAt (the transaction's now()), so the number keeps its order stable.
    rows.sort((x, y) => y.row.deletedAt.getTime() - x.row.deletedAt.getTime() || y.row.task.number - x.row.task.number);
    // Links only to tasks the caller can see, live or listed here: hidden tasks leave no trace.
    const listed = new Set(rows.map((r) => r.row.id));
    const others = [...new Set(rows.flatMap((r) => r.row.dependencies.flatMap((d) => [d.taskId, d.dependsOnId])))].filter(
      (id) => !listed.has(id),
    );
    const live = new Set<string>();
    for (const part of chunks(others)) {
      const found = await this.db
        .select({ id: tasks.id })
        .from(tasks)
        .where(and(a.taskScope(), inArray(tasks.id, part)));
      for (const t of found) live.add(t.id);
    }
    const seen = (id: string) => listed.has(id) || live.has(id);
    return rows.map(({ row, deletedByName }) => ({
      // Project and people as a restore would put them: a deleted project means the inbox.
      task: { ...row.task, projectId: this.landing(a, row), createdBy: row.createdBy, assigneeIds: row.assigneeIds },
      dependencies: row.dependencies.filter((d) => seen(d.taskId) && seen(d.dependsOnId)),
      deletedAt: row.deletedAt.toISOString(),
      deletedBy: row.deletedBy,
      deletedByName,
      purgeAt: new Date(row.deletedAt.getTime() + config.trashDays * 86_400_000).toISOString(),
      canRestore: this.canRestore(a, row),
    }));
  }

  /** "#12", "12", an id, or an unambiguous piece of the title of a task in the caller's trash. */
  async resolveTrashed(a: Access, ref: string): Promise<TrashItem> {
    const s = String(ref).trim();
    const items = await this.listTrash(a);
    let hit: TrashItem | undefined;
    if (/^#?\d+$/.test(s)) hit = items.find((i) => i.task.number === Number(s.replace('#', '')));
    else if (UUID_RE.test(s)) hit = items.find((i) => i.task.id === s);
    else if (s) {
      const lower = s.toLowerCase();
      const matches = items.filter((i) => i.task.title.toLowerCase().includes(lower));
      const exact = matches.filter((i) => i.task.title.toLowerCase() === lower);
      hit = exact.length === 1 ? exact[0] : matches.length === 1 ? matches[0] : undefined;
      if (!hit && matches.length > 1) {
        throw new BadRequestException(`휴지통에 "${s}"에 해당하는 작업이 여러 개입니다: ${matches.slice(0, 6).map((i) => taskSubject(i.task)).join(', ')}`);
      }
    }
    if (!hit) throw new NotFoundException(`휴지통에서 작업 "${s}"를 찾을 수 없습니다`);
    return hit;
  }

  /** An assignee stays only while still a member who can see where the task lands (as assertAssignees). */
  private async keptAssignee(conn: Conn, a: Access, assigneeId: string | null, projectId: string | null) {
    if (!assigneeId || assigneeId === a.userId) return assigneeId;
    if (a.kind === 'personal' || !(await this.access.membership(a.workspaceId, assigneeId, conn))) return null;
    if (projectId && !atLeast(await this.access.userLevel(a.workspaceId, assigneeId, projectId, conn), 'view')) return null;
    return assigneeId;
  }

  /**
   * Puts trashed tasks back as they were: same id, #number, dates and history, `updatedAt` now so
   * clients that load recent tasks get them. A task whose project is gone lands in the inbox. Then
   * the links whose both ends exist again are re-made, unless one would now close a cycle.
   * One task the caller may not restore cancels the whole call.
   *
   * Two restores at once of tasks that hold each other's links lock each other's trash rows (the
   * link is handed on to the row still in the trash) and Postgres aborts one as a deadlock; that one
   * simply runs again, by which time the other task is live and the link is re-made directly.
   */
  async restore(a: Access, ids: string[]): Promise<RestoreResult> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.restoreOnce(a, ids);
      } catch (e) {
        if (attempt < 2 && isDeadlock(e)) continue;
        throw e;
      }
    }
  }

  private async restoreOnce(a: Access, ids: string[]): Promise<RestoreResult> {
    const unique = [...new Set(ids)];
    return this.db.transaction(async (tx) => {
      const trashed: TaskTrashRow[] = [];
      const liveRows: Pick<TaskRow, 'id' | 'workspaceId' | 'projectId' | 'createdBy' | 'assigneeIds'>[] = [];
      for (const part of chunks(unique)) {
        // Locked, so a second restore of the same task waits and then finds it live instead.
        trashed.push(
          ...(await tx
            .select()
            .from(taskTrash)
            .where(and(this.trashScope(a), inArray(taskTrash.id, part)))
            .for('update')),
        );
        liveRows.push(
          ...(await tx
            .select({ id: tasks.id, workspaceId: tasks.workspaceId, projectId: tasks.projectId, createdBy: tasks.createdBy, assigneeIds: tasks.assigneeIds })
            .from(tasks)
            .where(inArray(tasks.id, part))),
        );
      }
      const live = new Set(liveRows.map((r) => r.id));
      const pending = trashed.filter((r) => !live.has(r.id));
      for (const r of pending) {
        if (!this.canRestore(a, r)) {
          throw new ForbiddenException(
            `${taskSubject(r.task)} 작업을 되살릴 권한이 없습니다 (보기 전용). 프로젝트 관리자에게 쓰기 권한을 요청하세요.`,
          );
        }
      }

      // Numbers are never handed out twice, so the old one is normally free; if not, a new one.
      const taken = new Set<number>();
      for (const part of chunks(pending.map((r) => r.task.number))) {
        const rows = await tx
          .select({ n: tasks.number })
          .from(tasks)
          .where(and(eq(tasks.workspaceId, a.workspaceId), inArray(tasks.number, part)));
        for (const r of rows) taken.add(r.n);
      }
      // One membership lookup per assignee and landing, however many of their tasks come back.
      const keptCache = new Map<string, Promise<string | null>>();
      const kept = (assigneeId: string | null, projectId: string | null) => {
        const key = `${assigneeId}:${projectId}`;
        if (!keptCache.has(key)) keptCache.set(key, this.keptAssignee(tx, a, assigneeId, projectId));
        return keptCache.get(key)!;
      };
      const values: (typeof tasks.$inferInsert)[] = [];
      for (const r of pending) {
        const t = r.task;
        const projectId = this.landing(a, r);
        const number = taken.has(t.number) ? await this.nextNumber(tx, a.workspaceId) : t.number;
        taken.add(number);
        const assigneeIds: string[] = [];
        for (const id of r.assigneeIds) {
          const k = await kept(id, projectId);
          if (k) assigneeIds.push(k);
        }
        // An org inbox task is seen only by its maker and its assignees. Restored by someone else (its
        // deleter, after its project went), it goes back to their inboxes, as when a project is deleted
        // without its tasks; but if none of them is in the org any more nobody could ever see it again,
        // so then the restorer becomes its assignee and keeps it.
        if (!a.taskLevel({ projectId, createdBy: r.createdBy, assigneeIds })) {
          const maker = projectId === null && r.createdBy ? await kept(r.createdBy, null) : null;
          if (!assigneeIds.length && !maker) assigneeIds.push(a.userId);
        }
        values.push({
          id: t.id,
          workspaceId: a.workspaceId,
          createdBy: r.createdBy,
          assigneeIds,
          number,
          projectId,
          title: t.title,
          notes: t.notes,
          status: t.status,
          priority: t.priority,
          startDate: t.startDate,
          startTime: t.startDate ? t.startTime : null,
          dueDate: t.dueDate,
          dueTime: t.dueDate ? t.dueTime : null,
          fixed: t.fixed,
          position: t.position,
          postponedCount: t.postponedCount,
          completedAt: t.completedAt ? new Date(t.completedAt) : null,
          createdAt: new Date(t.createdAt),
          updatedAt: new Date(),
        });
      }
      const restored: TaskRow[] = [];
      for (const part of chunks(values)) restored.push(...(await tx.insert(tasks).values(part).returning()));

      const snapshot = new Map<string, Dependency>();
      for (const r of pending) for (const d of r.dependencies) snapshot.set(linkKey(d), d);
      const ends = [...new Set([...snapshot.values()].flatMap((d) => [d.taskId, d.dependsOnId]))];
      const present = new Set<string>();
      for (const part of chunks(ends)) {
        const found = await tx
          .select({ id: tasks.id })
          .from(tasks)
          .where(and(eq(tasks.workspaceId, a.workspaceId), inArray(tasks.id, part)));
        for (const t of found) present.add(t.id);
      }
      // The whole workspace's links, not only visible ones: a hidden path can close a cycle too.
      const graph: Dependency[] = await tx
        .select({ taskId: taskDependencies.taskId, dependsOnId: taskDependencies.dependsOnId })
        .from(taskDependencies)
        .where(eq(taskDependencies.workspaceId, a.workspaceId));
      const existing = new Set(graph.map(linkKey));
      const relinked: Dependency[] = [];
      for (const d of snapshot.values()) {
        if (!present.has(d.taskId) || !present.has(d.dependsOnId) || existing.has(linkKey(d))) continue;
        if (wouldCreateCycle(graph, d.taskId, d.dependsOnId)) continue;
        graph.push(d);
        existing.add(linkKey(d));
        relinked.push(d);
      }
      for (const part of chunks(relinked)) {
        await tx
          .insert(taskDependencies)
          .values(part.map((d) => ({ ...d, workspaceId: a.workspaceId })))
          .onConflictDoNothing();
      }

      // A link whose other task is still in the trash moves into that task's snapshot, which may
      // lack it (deleted after the link went with this one), so restoring that task re-makes it.
      const waiting = new Map<string, Dependency[]>();
      for (const d of snapshot.values()) {
        for (const other of [d.taskId, d.dependsOnId]) {
          if (!present.has(other)) waiting.set(other, [...(waiting.get(other) ?? []), d]);
        }
      }
      for (const part of chunks([...waiting.keys()])) {
        const others = await tx
          .select({ id: taskTrash.id, dependencies: taskTrash.dependencies })
          .from(taskTrash)
          .where(and(eq(taskTrash.workspaceId, a.workspaceId), inArray(taskTrash.id, part)))
          .for('update');
        for (const o of others) {
          const merged = new Map(o.dependencies.map((d) => [linkKey(d), d]));
          for (const d of waiting.get(o.id)!) merged.set(linkKey(d), d);
          if (merged.size === o.dependencies.length) continue;
          await tx.update(taskTrash).set({ dependencies: [...merged.values()] }).where(eq(taskTrash.id, o.id));
        }
      }

      for (const row of restored) {
        await this.activity.record(tx, a, { action: 'task.restored', taskId: row.id, projectId: row.projectId, subject: taskSubject(row) });
      }
      for (const part of chunks(trashed.map((r) => r.id))) await tx.delete(taskTrash).where(inArray(taskTrash.id, part));

      const liveHere = liveRows.some((r) => r.workspaceId === a.workspaceId && a.taskLevel(r));
      if (!restored.length && !liveHere) throw new NotFoundException('휴지통에 없는 작업이에요');

      // What the caller sees afterwards, as bootstrap would show it.
      const visible = new Set(restored.filter((r) => a.taskLevel(r)).map((r) => r.id));
      const otherEnds = ends.filter((id) => present.has(id) && !visible.has(id));
      for (const part of chunks(otherEnds)) {
        const found = await tx
          .select({ id: tasks.id })
          .from(tasks)
          .where(and(a.taskScope(), inArray(tasks.id, part)));
        for (const t of found) visible.add(t.id);
      }
      const back = new Set(restored.map((r) => r.id));
      return {
        tasks: restored.filter((r) => visible.has(r.id)).map(toTask),
        dependencies: relinked.filter((d) => visible.has(d.taskId) && visible.has(d.dependsOnId)),
        missing: unique.filter((id) => !back.has(id)),
      };
    });
  }

  /** Deletes trashed tasks for good. Each needs the same right as restoring it; unknown ids are skipped. */
  async purge(a: Access, ids: string[]): Promise<{ purged: number }> {
    return this.db.transaction(async (tx) => {
      const rows: Pick<TaskTrashRow, 'id' | 'projectId' | 'createdBy' | 'assigneeIds' | 'deletedBy' | 'task'>[] = [];
      for (const part of chunks([...new Set(ids)])) {
        rows.push(
          ...(await tx
            .select({
              id: taskTrash.id,
              projectId: taskTrash.projectId,
              createdBy: taskTrash.createdBy,
              assigneeIds: taskTrash.assigneeIds,
              deletedBy: taskTrash.deletedBy,
              task: taskTrash.task,
            })
            .from(taskTrash)
            .where(and(this.trashScope(a), inArray(taskTrash.id, part)))),
        );
      }
      for (const r of rows) {
        if (!this.canRestore(a, r)) {
          throw new ForbiddenException(`${taskSubject(r.task)} 작업을 영구 삭제할 권한이 없습니다 (보기 전용).`);
        }
      }
      for (const part of chunks(rows.map((r) => r.id))) await tx.delete(taskTrash).where(inArray(taskTrash.id, part));
      return { purged: rows.length };
    });
  }

  /** Deletes for good everything in the caller's trash that they may restore; the rest stays. */
  async emptyTrash(a: Access): Promise<{ purged: number }> {
    const rows = await this.db
      .select({
        id: taskTrash.id,
        projectId: taskTrash.projectId,
        createdBy: taskTrash.createdBy,
        assigneeIds: taskTrash.assigneeIds,
        deletedBy: taskTrash.deletedBy,
      })
      .from(taskTrash)
      .where(this.trashScope(a));
    const ids = rows.filter((r) => this.canRestore(a, r)).map((r) => r.id);
    await this.db.transaction(async (tx) => {
      for (const part of chunks(ids)) await tx.delete(taskTrash).where(inArray(taskTrash.id, part));
    });
    return { purged: ids.length };
  }
}
