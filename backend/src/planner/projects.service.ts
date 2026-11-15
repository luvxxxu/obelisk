import { Injectable, NotFoundException } from '@nestjs/common';
import type { CreateProjectInput, Project, UpdateProjectInput } from '@obelisk/core';
import { PROJECT_COLORS } from '@obelisk/core';
import { and, asc, eq, ilike, isNull, max, sql } from 'drizzle-orm';
import { InjectDb, type Db } from '../db/db.module';
import { projects, tasks } from '../db/schema';
import { toProject } from './mappers';

@Injectable()
export class ProjectsService {
  constructor(@InjectDb() private readonly db: Db) {}

  async list(userId: string, opts: { includeArchived?: boolean } = {}): Promise<Project[]> {
    const rows = await this.db
      .select()
      .from(projects)
      .where(
        opts.includeArchived
          ? eq(projects.userId, userId)
          : and(eq(projects.userId, userId), isNull(projects.archivedAt)),
      )
      .orderBy(asc(projects.position), asc(projects.createdAt));
    return rows.map(toProject);
  }

  async get(userId: string, id: string): Promise<Project> {
    const row = await this.db.query.projects.findFirst({
      where: and(eq(projects.id, id), eq(projects.userId, userId)),
    });
    if (!row) throw new NotFoundException('프로젝트를 찾을 수 없습니다');
    return toProject(row);
  }

  /** Accepts a project id or (case-insensitive) name. */
  async resolve(userId: string, ref: string): Promise<Project> {
    const s = ref.trim();
    if (/^[0-9a-f-]{36}$/i.test(s)) return this.get(userId, s);
    const rows = await this.db
      .select()
      .from(projects)
      .where(and(eq(projects.userId, userId), ilike(projects.name, s)))
      .limit(1);
    if (rows[0]) return toProject(rows[0]);
    const fuzzy = await this.db
      .select()
      .from(projects)
      .where(and(eq(projects.userId, userId), ilike(projects.name, `%${s.replace(/[%_]/g, '\\$&')}%`)))
      .limit(2);
    if (fuzzy.length === 1) return toProject(fuzzy[0]!);
    throw new NotFoundException(`프로젝트 "${s}"를 찾을 수 없습니다`);
  }

  async create(userId: string, input: CreateProjectInput): Promise<Project> {
    const [agg] = await this.db
      .select({ pos: max(projects.position), n: sql<number>`count(*)::int` })
      .from(projects)
      .where(eq(projects.userId, userId));
    const color = input.color ?? PROJECT_COLORS[((agg?.n ?? 0) + 6) % PROJECT_COLORS.length]!;
    const [row] = await this.db
      .insert(projects)
      .values({ userId, name: input.name, color, position: (agg?.pos ?? 0) + 1 })
      .returning();
    return toProject(row!);
  }

  async update(userId: string, id: string, input: UpdateProjectInput): Promise<Project> {
    await this.get(userId, id);
    const { archived, ...rest } = input;
    const [row] = await this.db
      .update(projects)
      .set({
        ...rest,
        ...(archived === undefined ? {} : { archivedAt: archived ? new Date() : null }),
        updatedAt: new Date(),
      })
      .where(and(eq(projects.id, id), eq(projects.userId, userId)))
      .returning();
    return toProject(row!);
  }

  /** Deletes the project. Its tasks move to the inbox unless `deleteTasks`. */
  async remove(userId: string, id: string, opts: { deleteTasks?: boolean } = {}) {
    await this.get(userId, id);
    await this.db.transaction(async (tx) => {
      if (opts.deleteTasks) {
        await tx.delete(tasks).where(and(eq(tasks.projectId, id), eq(tasks.userId, userId)));
      }
      await tx.delete(projects).where(and(eq(projects.id, id), eq(projects.userId, userId)));
    });
    return { ok: true };
  }
}
