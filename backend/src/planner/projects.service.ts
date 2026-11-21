import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import {
  isWorkspaceAdmin,
  maxLevel,
  PROJECT_COLORS,
  type AccessLevel,
  type CreateProjectInput,
  type Project,
  type ProjectAccessInfo,
  type UpdateProjectAccessInput,
  type UpdateProjectInput,
} from '@obelisk/core';
import { and, asc, eq, ilike, inArray, isNull, max, notInArray, or, sql } from 'drizzle-orm';
import type { AuthContext } from '../auth/auth.service';
import { InjectDb, type Db } from '../db/db.module';
import {
  projectMembers,
  projects,
  projectTeams,
  taskDependencies,
  tasks,
  teamMembers,
  teams,
  users,
  workspaceMembers,
  workspaces,
  type ProjectRow,
} from '../db/schema';
import { AccessService, type Access } from '../workspace/access.service';
import { ActivityService, diff } from '../workspace/activity.service';
import { toProject } from './mappers';
import { TasksService } from './tasks.service';

const esc = (s: string) => s.replace(/[%_\\]/g, '\\$&');

@Injectable()
export class ProjectsService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly access: AccessService,
    private readonly activity: ActivityService,
    private readonly taskService: TasksService,
  ) {}

  private out(a: Access, row: ProjectRow): Project {
    return toProject(row, a.projectLevel(row.id) ?? 'view');
  }

  /** Projects the caller can see, in sidebar order. */
  async list(a: Access, opts: { includeArchived?: boolean } = {}): Promise<Project[]> {
    const visible = a.visibleProjectIds();
    if (!visible.length) return [];
    const rows = await this.db
      .select()
      .from(projects)
      .where(
        and(
          eq(projects.workspaceId, a.workspaceId),
          inArray(projects.id, visible),
          opts.includeArchived ? undefined : isNull(projects.archivedAt),
        ),
      )
      .orderBy(asc(projects.position), asc(projects.createdAt));
    return rows.map((r) => this.out(a, r));
  }

  private async row(a: Access, id: string): Promise<ProjectRow> {
    const row = await this.db.query.projects.findFirst({
      where: and(eq(projects.id, id), eq(projects.workspaceId, a.workspaceId)),
    });
    if (!row || !a.projectLevel(row.id)) throw new NotFoundException('프로젝트를 찾을 수 없습니다');
    return row;
  }

  async get(a: Access, id: string): Promise<Project> {
    return this.out(a, await this.row(a, id));
  }

  /** Accepts a project id or (case-insensitive) name, among projects the caller can see. */
  async resolve(a: Access, ref: string): Promise<Project> {
    const s = ref.trim();
    if (/^[0-9a-f-]{36}$/i.test(s)) return this.get(a, s);
    const visible = a.visibleProjectIds();
    if (visible.length) {
      const scope = and(eq(projects.workspaceId, a.workspaceId), inArray(projects.id, visible));
      const exact = await this.db.select().from(projects).where(and(scope, ilike(projects.name, esc(s)))).limit(1);
      if (exact[0]) return this.out(a, exact[0]);
      const fuzzy = await this.db.select().from(projects).where(and(scope, ilike(projects.name, `%${esc(s)}%`))).limit(2);
      if (fuzzy.length === 1) return this.out(a, fuzzy[0]!);
    }
    throw new NotFoundException(`프로젝트 "${s}"를 찾을 수 없습니다`);
  }

  /**
   * In an organization the creator gets a "manage" grant (so the project stays theirs even
   * if their role changes) and everyone else gets `memberAccess` — private by default.
   */
  async create(a: Access, input: CreateProjectInput): Promise<{ project: Project; access: Access }> {
    if (!a.canCreateProjects) {
      throw new ForbiddenException('이 조직에서는 소유자와 관리자만 프로젝트를 만들 수 있습니다');
    }
    return this.db.transaction(async (tx) => {
      const [agg] = await tx
        .select({ pos: max(projects.position), n: sql<number>`count(*)::int` })
        .from(projects)
        .where(eq(projects.workspaceId, a.workspaceId));
      const color = input.color ?? PROJECT_COLORS[((agg?.n ?? 0) + 6) % PROJECT_COLORS.length]!;
      const [row] = await tx
        .insert(projects)
        .values({
          workspaceId: a.workspaceId,
          createdBy: a.userId,
          name: input.name,
          color,
          memberAccess: a.kind === 'org' ? (input.memberAccess ?? 'none') : 'none',
          position: (agg?.pos ?? 0) + 1,
        })
        .returning();
      if (a.kind === 'org') {
        await tx.insert(projectMembers).values({ projectId: row!.id, userId: a.userId, level: 'manage' });
      }
      await this.activity.record(tx, a, {
        action: 'project.created',
        projectId: row!.id,
        subject: row!.name,
        data: a.kind === 'org' ? { memberAccess: row!.memberAccess } : {},
      });
      const next = await this.access.refresh(a, tx);
      return { project: toProject(row!, next.projectLevel(row!.id) ?? 'manage'), access: next };
    });
  }

  async update(a: Access, id: string, input: UpdateProjectInput): Promise<Project> {
    const cur = await this.row(a, id);
    // Sidebar order is shared, so it is a write; renaming, recoloring and archiving are management.
    const onlyPosition = Object.keys(input).every((k) => k === 'position');
    a.assertProject(id, onlyPosition ? 'edit' : 'manage', cur.name);
    const { archived, ...rest } = input;
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .update(projects)
        .set({
          ...rest,
          ...(archived === undefined ? {} : { archivedAt: archived ? new Date() : null }),
          updatedAt: onlyPosition ? cur.updatedAt : new Date(),
        })
        .where(and(eq(projects.id, id), eq(projects.workspaceId, a.workspaceId)))
        .returning();
      const changes = diff({ name: cur.name, color: cur.color, archived: !!cur.archivedAt }, input, ['name', 'color', 'archived']);
      if (Object.keys(changes).length) {
        const action = 'archived' in changes ? (archived ? 'project.archived' : 'project.unarchived') : 'project.updated';
        await this.activity.record(tx, a, { action, projectId: id, subject: row!.name, data: { changes } });
      }
      return this.out(a, row!);
    });
  }

  /**
   * Deletes the project. Its tasks move to the inbox, or with `deleteTasks` to the trash, from where
   * a restore puts them in the inbox (the project is gone). Only the project deletion is logged.
   */
  async remove(a: Access, id: string, opts: { deleteTasks?: boolean } = {}) {
    const cur = await this.row(a, id);
    a.assertProject(id, 'manage', cur.name);
    await this.db.transaction(async (tx) => {
      if (opts.deleteTasks) {
        const rows = await tx.select().from(tasks).where(and(eq(tasks.projectId, id), eq(tasks.workspaceId, a.workspaceId)));
        await this.taskService.moveToTrash(tx, a, rows);
      }
      await tx.delete(projects).where(and(eq(projects.id, id), eq(projects.workspaceId, a.workspaceId)));
      await this.activity.record(tx, a, {
        action: 'project.deleted',
        projectId: id,
        subject: cur.name,
        data: { tasks: opts.deleteTasks ? 'deleted' : 'inbox' },
      });
    });
    return { ok: true };
  }

  // ───────────────────────────── sharing

  /** Who can reach the project and why. Anyone who can see the project may look. */
  async getAccess(a: Access, id: string): Promise<ProjectAccessInfo> {
    const cur = await this.row(a, id);
    const [memberGrants, teamGrants, members, teamLinks] = await Promise.all([
      this.db.select().from(projectMembers).where(eq(projectMembers.projectId, id)),
      this.db.select().from(projectTeams).where(eq(projectTeams.projectId, id)),
      this.db
        .select({ userId: workspaceMembers.userId, role: workspaceMembers.role })
        .from(workspaceMembers)
        .where(eq(workspaceMembers.workspaceId, a.workspaceId)),
      this.db
        .select({ teamId: teamMembers.teamId, userId: teamMembers.userId })
        .from(teamMembers)
        .innerJoin(teams, eq(teams.id, teamMembers.teamId))
        .where(eq(teams.workspaceId, a.workspaceId)),
    ]);
    const effective = members.map((m) => {
      if (isWorkspaceAdmin(m.role)) return { userId: m.userId, level: 'manage' as AccessLevel, source: 'role' as const };
      const own = memberGrants.find((g) => g.userId === m.userId)?.level ?? null;
      const myTeams = teamLinks.filter((l) => l.userId === m.userId).map((l) => l.teamId);
      const viaTeam = maxLevel(...teamGrants.filter((g) => myTeams.includes(g.teamId)).map((g) => g.level));
      const everyone = cur.memberAccess === 'none' ? null : cur.memberAccess;
      const level = maxLevel(own, viaTeam, everyone);
      const source = !level ? null : level === own ? 'member' : level === viaTeam ? 'team' : 'everyone';
      return { userId: m.userId, level, source } as const;
    });
    return {
      projectId: id,
      memberAccess: cur.memberAccess,
      members: memberGrants.map((g) => ({ userId: g.userId, level: g.level })),
      teams: teamGrants.map((g) => ({ teamId: g.teamId, level: g.level })),
      effective: effective.map((e) => ({ ...e })),
    };
  }

  async updateAccess(a: Access, id: string, input: UpdateProjectAccessInput): Promise<ProjectAccessInfo> {
    a.assertOrg();
    const cur = await this.row(a, id);
    a.assertProject(id, 'manage', cur.name);
    await this.db.transaction(async (tx) => {
      const changes: Record<string, unknown>[] = [];
      if (input.memberAccess && input.memberAccess !== cur.memberAccess) {
        await tx.update(projects).set({ memberAccess: input.memberAccess, updatedAt: new Date() }).where(eq(projects.id, id));
        changes.push({ everyone: { from: cur.memberAccess, to: input.memberAccess } });
      }
      if (input.members?.length) {
        const ids = [...new Set(input.members.map((m) => m.userId))];
        const known = await tx
          .select({ userId: workspaceMembers.userId, name: users.name })
          .from(workspaceMembers)
          .innerJoin(users, eq(users.id, workspaceMembers.userId))
          .where(and(eq(workspaceMembers.workspaceId, a.workspaceId), inArray(workspaceMembers.userId, ids)));
        if (known.length !== ids.length) throw new BadRequestException('조직 멤버에게만 권한을 줄 수 있습니다');
        const before = await tx.select().from(projectMembers).where(eq(projectMembers.projectId, id));
        for (const m of input.members) {
          const prev = before.find((b) => b.userId === m.userId)?.level ?? null;
          if (prev === m.level) continue;
          if (m.level === null) {
            await tx.delete(projectMembers).where(and(eq(projectMembers.projectId, id), eq(projectMembers.userId, m.userId)));
          } else {
            await tx
              .insert(projectMembers)
              .values({ projectId: id, userId: m.userId, level: m.level })
              .onConflictDoUpdate({ target: [projectMembers.projectId, projectMembers.userId], set: { level: m.level } });
          }
          changes.push({ member: known.find((k) => k.userId === m.userId)!.name, userId: m.userId, from: prev, to: m.level });
        }
      }
      if (input.teams?.length) {
        const ids = [...new Set(input.teams.map((t) => t.teamId))];
        const known = await tx
          .select({ id: teams.id, name: teams.name })
          .from(teams)
          .where(and(eq(teams.workspaceId, a.workspaceId), inArray(teams.id, ids)));
        if (known.length !== ids.length) throw new BadRequestException('이 조직의 팀에게만 권한을 줄 수 있습니다');
        const before = await tx.select().from(projectTeams).where(eq(projectTeams.projectId, id));
        for (const t of input.teams) {
          const prev = before.find((b) => b.teamId === t.teamId)?.level ?? null;
          if (prev === t.level) continue;
          if (t.level === null) {
            await tx.delete(projectTeams).where(and(eq(projectTeams.projectId, id), eq(projectTeams.teamId, t.teamId)));
          } else {
            await tx
              .insert(projectTeams)
              .values({ projectId: id, teamId: t.teamId, level: t.level })
              .onConflictDoUpdate({ target: [projectTeams.projectId, projectTeams.teamId], set: { level: t.level } });
          }
          changes.push({ team: known.find((k) => k.id === t.teamId)!.name, teamId: t.teamId, from: prev, to: t.level });
        }
      }
      if (changes.length) await this.activity.record(tx, a, { action: 'project.access', projectId: id, subject: cur.name, data: { changes } });
    });
    return this.getAccess(await this.access.refresh(a), id);
  }

  // ───────────────────────────── move between workspaces

  /**
   * Moves a project and all its tasks to another workspace the caller belongs to.
   * Needs "manage" here and the right to create projects there. Tasks get new numbers
   * there; dependency links to tasks that stay behind are cut; assignees who aren't
   * members there are cleared; sharing starts over (private, mover manages).
   */
  async move(a: Access, auth: AuthContext, id: string, targetId: string) {
    const cur = await this.row(a, id);
    a.assertProject(id, 'manage', cur.name);
    if (targetId === a.workspaceId) throw new BadRequestException('이미 이 공간에 있는 프로젝트입니다');
    const target = await this.access.forWorkspace(auth, targetId);
    if (!target.canCreateProjects) throw new ForbiddenException(`"${target.workspace.name}"에 프로젝트를 만들 권한이 없습니다`);

    const result = await this.db.transaction(async (tx) => {
      // Lock both sequences in a stable order: numbering in the target must not race other inserts.
      await tx.execute(sql`select id from ${workspaces} where id in (${a.workspaceId}, ${targetId}) order by id for update`);
      const moving = await tx
        .select({ id: tasks.id, number: tasks.number, assigneeId: tasks.assigneeId })
        .from(tasks)
        .where(and(eq(tasks.projectId, id), eq(tasks.workspaceId, a.workspaceId)))
        .orderBy(asc(tasks.number));
      const ids = moving.map((t) => t.id);
      let cut = 0;
      if (ids.length) {
        const crossing = await tx
          .delete(taskDependencies)
          .where(
            and(
              eq(taskDependencies.workspaceId, a.workspaceId),
              or(
                and(inArray(taskDependencies.taskId, ids), notInArray(taskDependencies.dependsOnId, ids)),
                and(inArray(taskDependencies.dependsOnId, ids), notInArray(taskDependencies.taskId, ids)),
              ),
            ),
          )
          .returning();
        cut = crossing.length;
        await tx.update(taskDependencies).set({ workspaceId: targetId }).where(inArray(taskDependencies.taskId, ids));
        const [seq] = await tx
          .update(workspaces)
          .set({ taskSeq: sql`${workspaces.taskSeq} + ${ids.length}` })
          .where(eq(workspaces.id, targetId))
          .returning({ seq: workspaces.taskSeq });
        const first = seq!.seq - ids.length + 1;
        const targetMembers = new Set(
          (await tx.select({ userId: workspaceMembers.userId }).from(workspaceMembers).where(eq(workspaceMembers.workspaceId, targetId))).map(
            (m) => m.userId,
          ),
        );
        for (const [i, t] of moving.entries()) {
          await tx
            .update(tasks)
            .set({
              workspaceId: targetId,
              number: first + i,
              ...(t.assigneeId && !targetMembers.has(t.assigneeId) ? { assigneeId: null } : {}),
            })
            .where(eq(tasks.id, t.id));
        }
      }
      await tx.delete(projectMembers).where(eq(projectMembers.projectId, id));
      await tx.delete(projectTeams).where(eq(projectTeams.projectId, id));
      const [agg] = await tx.select({ pos: max(projects.position) }).from(projects).where(eq(projects.workspaceId, targetId));
      const [row] = await tx
        .update(projects)
        .set({ workspaceId: targetId, memberAccess: 'none', position: (agg?.pos ?? 0) + 1, updatedAt: new Date() })
        .where(eq(projects.id, id))
        .returning();
      if (target.kind === 'org') await tx.insert(projectMembers).values({ projectId: id, userId: a.userId, level: 'manage' });
      const data = { from: a.workspace.name, to: target.workspace.name, tasks: ids.length, linksCut: cut };
      await this.activity.record(tx, a, { action: 'project.moved_out', projectId: id, subject: cur.name, data });
      await this.activity.recordIn(tx, a, targetId, { action: 'project.moved_in', projectId: id, subject: cur.name, data });
      return { row: row!, tasks: ids.length, linksCut: cut };
    });
    const next = await this.access.refresh(target);
    return {
      project: toProject(result.row, next.projectLevel(id) ?? 'manage'),
      workspace: { id: target.workspaceId, name: target.workspace.name },
      tasks: result.tasks,
      linksCut: result.linksCut,
    };
  }
}
