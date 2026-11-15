import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  matchesView,
  compareTasks,
  compareDone,
  wouldCreateCycle,
  type BulkCreateTasksInput,
  type CreateTaskInput,
  type Dependency,
  type ISODate,
  type RescheduleInput,
  type Task,
  type TaskStatus,
  type UpdateTaskInput,
  type ViewName,
} from '@obelisk/core';
import { and, desc, eq, gte, ilike, inArray, or, sql } from 'drizzle-orm';
import { InjectDb, type Db } from '../db/db.module';
import { projects, taskDependencies, tasks, users, type TaskRow } from '../db/schema';
import { toTask } from './mappers';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type Conn = Db | Tx;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTIVE: TaskStatus[] = ['todo', 'doing'];

export interface TaskFilter {
  view?: ViewName;
  projectId?: string | null;
  status?: TaskStatus;
  query?: string;
  from?: ISODate;
  to?: ISODate;
  limit?: number;
}

@Injectable()
export class TasksService {
  constructor(@InjectDb() private readonly db: Db) {}

  // ───────────────────────────── reads

  async get(userId: string, id: string, conn: Conn = this.db): Promise<Task> {
    const row = await conn.query.tasks.findFirst({ where: and(eq(tasks.id, id), eq(tasks.userId, userId)) });
    if (!row) throw new NotFoundException('작업을 찾을 수 없습니다');
    return toTask(row);
  }

  /** "#12", "12", a uuid, or an unambiguous piece of the title. */
  async resolve(userId: string, ref: string): Promise<Task> {
    const s = String(ref).trim();
    let row: TaskRow | undefined;
    if (/^#?\d+$/.test(s)) {
      row = await this.db.query.tasks.findFirst({
        where: and(eq(tasks.userId, userId), eq(tasks.number, Number(s.replace('#', '')))),
      });
    } else if (UUID_RE.test(s)) {
      row = await this.db.query.tasks.findFirst({ where: and(eq(tasks.userId, userId), eq(tasks.id, s)) });
    } else if (s) {
      const pattern = `%${s.replace(/[%_\\]/g, '\\$&')}%`;
      const rows = await this.db
        .select()
        .from(tasks)
        .where(and(eq(tasks.userId, userId), ilike(tasks.title, pattern)))
        .orderBy(sql`case when ${tasks.status} in ('todo','doing') then 0 else 1 end`, desc(tasks.updatedAt))
        .limit(6);
      const exact = rows.filter((r) => r.title.toLowerCase() === s.toLowerCase());
      const active = rows.filter((r) => ACTIVE.includes(r.status));
      if (exact.length === 1) row = exact[0];
      else if (rows.length === 1) row = rows[0];
      else if (active.length === 1) row = active[0];
      else if (rows.length > 1) {
        throw new BadRequestException(
          `"${s}"에 해당하는 작업이 여러 개입니다: ${rows.map((r) => `#${r.number} ${r.title}`).join(', ')}`,
        );
      }
    }
    if (!row) throw new NotFoundException(`작업 "${s}"를 찾을 수 없습니다`);
    return toTask(row);
  }

  /** Active tasks plus everything finished in the last `recentDays`. */
  async listForClient(userId: string, recentDays = 30): Promise<Task[]> {
    const since = new Date(Date.now() - recentDays * 86_400_000);
    const rows = await this.db
      .select()
      .from(tasks)
      .where(
        and(
          eq(tasks.userId, userId),
          or(inArray(tasks.status, ACTIVE), gte(tasks.updatedAt, since)),
        ),
      );
    return rows.map(toTask);
  }

  async listActive(userId: string, conn: Conn = this.db): Promise<Task[]> {
    const rows = await conn
      .select()
      .from(tasks)
      .where(and(eq(tasks.userId, userId), inArray(tasks.status, ACTIVE)));
    return rows.map(toTask);
  }

  async list(userId: string, f: TaskFilter, today: ISODate): Promise<Task[]> {
    const wantsClosed = f.view === 'done' || f.status === 'done' || f.status === 'canceled';
    const conds = [eq(tasks.userId, userId)];
    if (!wantsClosed) conds.push(inArray(tasks.status, ACTIVE));
    else conds.push(inArray(tasks.status, f.status === 'canceled' ? ['canceled'] : ['done']));
    if (f.projectId !== undefined) {
      conds.push(f.projectId === null ? sql`${tasks.projectId} is null` : eq(tasks.projectId, f.projectId));
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

  async dependencies(userId: string, conn: Conn = this.db): Promise<Dependency[]> {
    return conn
      .select({ taskId: taskDependencies.taskId, dependsOnId: taskDependencies.dependsOnId })
      .from(taskDependencies)
      .where(eq(taskDependencies.userId, userId));
  }

  // ───────────────────────────── writes

  private async assertProject(conn: Conn, userId: string, projectId: string | null | undefined) {
    if (!projectId) return;
    const p = await conn.query.projects.findFirst({
      where: and(eq(projects.id, projectId), eq(projects.userId, userId)),
    });
    if (!p) throw new BadRequestException('존재하지 않는 프로젝트입니다');
  }

  private async nextNumber(conn: Conn, userId: string): Promise<number> {
    const [row] = await conn
      .update(users)
      .set({ taskSeq: sql`${users.taskSeq} + 1` })
      .where(eq(users.id, userId))
      .returning({ seq: users.taskSeq });
    return row!.seq;
  }

  private async insertTask(
    tx: Tx,
    userId: string,
    input: Omit<CreateTaskInput, 'blockedBy'>,
  ): Promise<TaskRow> {
    await this.assertProject(tx, userId, input.projectId);
    const number = await this.nextNumber(tx, userId);
    const status = input.status ?? 'todo';
    const [row] = await tx
      .insert(tasks)
      .values({
        userId,
        number,
        title: input.title,
        notes: input.notes ?? '',
        status,
        priority: input.priority ?? 0,
        projectId: input.projectId ?? null,
        startDate: input.startDate ?? null,
        dueDate: input.dueDate ?? null,
        fixed: input.fixed ?? false,
        position: Date.now() / 1000,
        completedAt: status === 'done' ? new Date() : null,
      })
      .returning();
    return row!;
  }

  async create(userId: string, input: CreateTaskInput): Promise<Task> {
    if (input.startDate && input.dueDate && input.startDate > input.dueDate) {
      throw new BadRequestException('시작일은 마감일보다 늦을 수 없습니다');
    }
    return this.db.transaction(async (tx) => {
      const row = await this.insertTask(tx, userId, input);
      for (const dep of new Set(input.blockedBy ?? [])) {
        await this.get(userId, dep, tx);
        await tx.insert(taskDependencies).values({ taskId: row.id, dependsOnId: dep, userId }).onConflictDoNothing();
      }
      return toTask(row);
    });
  }

  /**
   * Create a batch of tasks in one go, wiring dependencies by in-batch `key`
   * or by existing task ref (#number / uuid). Ideal for AI-generated plans.
   */
  async createMany(userId: string, input: BulkCreateTasksInput) {
    return this.db.transaction(async (tx) => {
      const keyToId = new Map<string, string>();
      const created: TaskRow[] = [];
      for (const item of input.tasks) {
        if (item.startDate && item.dueDate && item.startDate > item.dueDate) {
          throw new BadRequestException(`"${item.title}": 시작일은 마감일보다 늦을 수 없습니다`);
        }
        const row = await this.insertTask(tx, userId, { ...item, projectId: item.projectId ?? input.projectId });
        created.push(row);
        if (item.key) keyToId.set(item.key, row.id);
      }
      const deps = await this.dependencies(userId, tx);
      const added: Dependency[] = [];
      for (const [i, item] of input.tasks.entries()) {
        for (const ref of item.blockedBy ?? []) {
          const dependsOnId = keyToId.get(ref) ?? (await this.resolveIn(tx, userId, ref));
          const taskId = created[i]!.id;
          if (wouldCreateCycle(deps, taskId, dependsOnId)) {
            throw new BadRequestException(`"${item.title}" → "${ref}" 의존성이 순환을 만듭니다`);
          }
          deps.push({ taskId, dependsOnId });
          added.push({ taskId, dependsOnId });
          await tx.insert(taskDependencies).values({ taskId, dependsOnId, userId }).onConflictDoNothing();
        }
      }
      return { tasks: created.map(toTask), dependencies: added };
    });
  }

  private async resolveIn(conn: Conn, userId: string, ref: string): Promise<string> {
    const s = ref.trim();
    const row = /^#?\d+$/.test(s)
      ? await conn.query.tasks.findFirst({
          where: and(eq(tasks.userId, userId), eq(tasks.number, Number(s.replace('#', '')))),
        })
      : UUID_RE.test(s)
        ? await conn.query.tasks.findFirst({ where: and(eq(tasks.userId, userId), eq(tasks.id, s)) })
        : undefined;
    if (!row) throw new BadRequestException(`blockedBy "${ref}"를 찾을 수 없습니다 (배치 내 key, #번호, id 중 하나)`);
    return row.id;
  }

  async update(userId: string, id: string, patch: UpdateTaskInput, conn: Conn = this.db): Promise<Task> {
    const cur = await this.get(userId, id, conn);
    const start = patch.startDate !== undefined ? patch.startDate : cur.startDate;
    const due = patch.dueDate !== undefined ? patch.dueDate : cur.dueDate;
    if (start && due && start > due) throw new BadRequestException('시작일은 마감일보다 늦을 수 없습니다');
    if (patch.projectId !== undefined) await this.assertProject(conn, userId, patch.projectId);

    const set: Partial<TaskRow> = { ...patch, updatedAt: new Date() } as Partial<TaskRow>;
    if (patch.status && patch.status !== cur.status) {
      set.completedAt = patch.status === 'done' ? new Date() : null;
    }
    if (cur.dueDate && due && due > cur.dueDate) set.postponedCount = cur.postponedCount + 1;

    const [row] = await conn
      .update(tasks)
      .set(set)
      .where(and(eq(tasks.id, id), eq(tasks.userId, userId)))
      .returning();
    return toTask(row!);
  }

  async reschedule(userId: string, input: RescheduleInput): Promise<Task[]> {
    return this.db.transaction(async (tx) => {
      const out: Task[] = [];
      for (const c of input.changes) {
        if (c.startDate && c.dueDate && c.startDate > c.dueDate) {
          throw new BadRequestException('시작일은 마감일보다 늦을 수 없습니다');
        }
        const cur = await this.get(userId, c.taskId, tx);
        const later = !!(cur.dueDate && c.dueDate && c.dueDate > cur.dueDate);
        const [row] = await tx
          .update(tasks)
          .set({
            startDate: c.startDate,
            dueDate: c.dueDate,
            updatedAt: new Date(),
            ...(later && c.taskId === input.rootId ? { postponedCount: cur.postponedCount + 1 } : {}),
          })
          .where(and(eq(tasks.id, c.taskId), eq(tasks.userId, userId)))
          .returning();
        out.push(toTask(row!));
      }
      return out;
    });
  }

  async remove(userId: string, id: string) {
    await this.get(userId, id);
    await this.db.delete(tasks).where(and(eq(tasks.id, id), eq(tasks.userId, userId)));
    return { ok: true };
  }

  async addDependency(userId: string, taskId: string, dependsOnId: string): Promise<Dependency> {
    await this.get(userId, taskId);
    await this.get(userId, dependsOnId);
    const deps = await this.dependencies(userId);
    if (wouldCreateCycle(deps, taskId, dependsOnId)) {
      throw new BadRequestException('순환 의존성은 만들 수 없습니다 (서로가 서로를 기다리게 됩니다)');
    }
    await this.db.insert(taskDependencies).values({ taskId, dependsOnId, userId }).onConflictDoNothing();
    return { taskId, dependsOnId };
  }

  async removeDependency(userId: string, taskId: string, dependsOnId: string) {
    await this.db
      .delete(taskDependencies)
      .where(
        and(
          eq(taskDependencies.userId, userId),
          eq(taskDependencies.taskId, taskId),
          eq(taskDependencies.dependsOnId, dependsOnId),
        ),
      );
    return { ok: true };
  }
}
