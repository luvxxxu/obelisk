import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import {
  atLeast,
  canEditTask,
  isWorkspaceAdmin,
  maxLevel,
  taskAccess,
  type AccessLevel,
  type AccessView,
  type TaskAccessSubject,
  type WorkspaceKind,
  type WorkspaceRole,
} from '@obelisk/core';
import { and, eq, ilike, inArray, isNull, or, type SQL } from 'drizzle-orm';
import type { Request } from 'express';
import type { AuthContext } from '../auth/auth.service';
import { InjectDb, type Db } from '../db/db.module';
import {
  projectMembers,
  projects,
  projectTeams,
  tasks,
  teamMembers,
  teams,
  workspaceMembers,
  workspaces,
  type UserRow,
  type WorkspaceRow,
} from '../db/schema';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
export type Conn = Db | Tx;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const WORKSPACE_HEADER = 'x-obelisk-workspace';

/**
 * Everything a request may do inside one workspace: who is calling, through
 * which door, their role, and their level on every project they can see.
 * Built once per request; services take it instead of a bare user id.
 */
export class Access implements AccessView {
  constructor(
    readonly user: UserRow,
    readonly via: AuthContext['via'],
    /** OAuth app or API token name, for the activity log. */
    readonly client: string | null,
    readonly workspace: WorkspaceRow,
    readonly role: WorkspaceRole,
    /** Projects this caller can see, with their level. Missing = no access. */
    readonly levels: Map<string, AccessLevel>,
  ) {}

  get userId() {
    return this.user.id;
  }
  get workspaceId() {
    return this.workspace.id;
  }
  get kind(): WorkspaceKind {
    return this.workspace.kind;
  }
  get admin() {
    return isWorkspaceAdmin(this.role);
  }
  get isOwner() {
    return this.role === 'owner';
  }
  get canCreateProjects() {
    return this.kind === 'personal' || this.admin || this.workspace.membersCanCreateProjects;
  }

  projectLevel(projectId: string): AccessLevel | null {
    return this.levels.get(projectId) ?? null;
  }

  visibleProjectIds(): string[] {
    return [...this.levels.keys()];
  }

  taskLevel(t: TaskAccessSubject) {
    return taskAccess(t, this);
  }

  /** SQL condition: tasks of this workspace the caller can see. */
  taskScope(): SQL {
    const ws = eq(tasks.workspaceId, this.workspaceId);
    if (this.kind === 'personal') return ws;
    const inbox = and(isNull(tasks.projectId), or(eq(tasks.createdBy, this.userId), eq(tasks.assigneeId, this.userId)))!;
    const visible = this.visibleProjectIds();
    return and(ws, visible.length ? or(inArray(tasks.projectId, visible), inbox) : inbox)!;
  }

  // ── assertions (403 for "you can see it but not do that", 404 for "you can't see it")

  assertAdmin(what = '이 작업') {
    if (!this.admin) throw new ForbiddenException(`${what}은(는) 조직 소유자나 관리자만 할 수 있습니다`);
  }

  assertOrg() {
    if (this.kind !== 'org') throw new ForbiddenException('개인 공간에서는 할 수 없는 작업입니다. 조직에서 사용하세요.');
  }

  assertProject(projectId: string, min: AccessLevel, projectName?: string) {
    const level = this.projectLevel(projectId);
    if (!level) throw new NotFoundException('프로젝트를 찾을 수 없습니다');
    if (!atLeast(level, min)) {
      const name = projectName ? `"${projectName}" 프로젝트` : '이 프로젝트';
      throw new ForbiddenException(
        min === 'manage'
          ? `${name}를 관리할 권한이 없습니다 (관리 권한 필요)`
          : `${name}에 쓰기 권한이 없습니다 (보기 전용). 프로젝트 관리자에게 쓰기 권한을 요청하세요.`,
      );
    }
  }

  assertTaskEditable(t: TaskAccessSubject & { number?: number; title?: string }) {
    if (canEditTask(t, this)) return;
    const name = t.number ? `#${t.number}${t.title ? ` ${t.title}` : ''}` : '이 작업';
    throw new ForbiddenException(
      `${name} 작업을 바꿀 권한이 없습니다 (보기 전용). 프로젝트 관리자에게 쓰기 권한을 요청하세요.`,
    );
  }
}

@Injectable()
export class AccessService {
  constructor(@InjectDb() private readonly db: Db) {}

  /** Workspace named by the request (header or ?workspace=), else the user's default. */
  fromRequest(auth: AuthContext, req: Request): Promise<Access> {
    const header = req.headers[WORKSPACE_HEADER];
    const q = (req.query as Record<string, unknown> | undefined)?.workspace;
    const ref = (Array.isArray(header) ? header[0] : header) ?? (typeof q === 'string' ? q : undefined);
    return this.resolve(auth, ref);
  }

  /**
   * Accepts a workspace id or name (case-insensitive), or "personal"/"개인".
   * Without a ref: the user's default workspace, falling back to their personal space.
   */
  async resolve(auth: AuthContext, ref?: string | null): Promise<Access> {
    const s = ref?.trim();
    if (s) return this.forWorkspace(auth, await this.findWorkspaceId(auth.user.id, s));
    const def = auth.user.defaultWorkspaceId;
    if (def && (await this.membership(def, auth.user.id))) return this.forWorkspace(auth, def);
    return this.forWorkspace(auth, await this.personalId(auth.user.id));
  }

  async personalId(userId: string, conn: Conn = this.db): Promise<string> {
    const row = await conn.query.workspaces.findFirst({ where: eq(workspaces.personalUserId, userId) });
    if (row) return row.id;
    // Accounts always get one at sign-up; heal if one is ever missing.
    const [created] = await conn
      .insert(workspaces)
      .values({ kind: 'personal', name: '개인 공간', personalUserId: userId })
      .onConflictDoNothing()
      .returning();
    const id = created?.id ?? (await conn.query.workspaces.findFirst({ where: eq(workspaces.personalUserId, userId) }))!.id;
    await conn.insert(workspaceMembers).values({ workspaceId: id, userId, role: 'owner' }).onConflictDoNothing();
    return id;
  }

  private async findWorkspaceId(userId: string, ref: string): Promise<string> {
    if (/^(personal|개인|개인 공간|me)$/i.test(ref)) return this.personalId(userId);
    const mine = this.db
      .select({ id: workspaces.id, name: workspaces.name, kind: workspaces.kind })
      .from(workspaces)
      .innerJoin(workspaceMembers, eq(workspaceMembers.workspaceId, workspaces.id))
      .$dynamic();
    if (UUID_RE.test(ref)) {
      const rows = await mine.where(and(eq(workspaceMembers.userId, userId), eq(workspaces.id, ref))).limit(1);
      if (rows[0]) return rows[0].id;
    } else {
      const rows = await mine
        .where(and(eq(workspaceMembers.userId, userId), eq(workspaces.kind, 'org'), ilike(workspaces.name, ref.replace(/[%_\\]/g, '\\$&'))))
        .limit(2);
      if (rows.length === 1) return rows[0]!.id;
      if (rows.length > 1) throw new NotFoundException(`"${ref}" 이름의 조직이 여러 개입니다. id로 지정하세요.`);
    }
    throw new NotFoundException(`공간 "${ref}"을(를) 찾을 수 없거나 멤버가 아닙니다`);
  }

  async membership(workspaceId: string, userId: string, conn: Conn = this.db) {
    return conn.query.workspaceMembers.findFirst({
      where: and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)),
    });
  }

  async forWorkspace(auth: AuthContext, workspaceId: string, conn: Conn = this.db): Promise<Access> {
    const [ws, member] = await Promise.all([
      conn.query.workspaces.findFirst({ where: eq(workspaces.id, workspaceId) }),
      this.membership(workspaceId, auth.user.id, conn),
    ]);
    if (!ws || !member) throw new NotFoundException('공간을 찾을 수 없거나 멤버가 아닙니다');
    const levels = await this.levelsFor(ws.id, auth.user.id, member.role, conn);
    return new Access(auth.user, auth.via, auth.client ?? null, ws, member.role, levels, );
  }

  /** The workspace a task lives in — so links by id work whatever workspace the client has open. */
  async forTask(auth: AuthContext, taskId: string): Promise<Access> {
    const row = await this.db.query.tasks.findFirst({ where: eq(tasks.id, taskId), columns: { workspaceId: true } });
    if (!row) throw new NotFoundException('작업을 찾을 수 없습니다');
    return this.forWorkspace(auth, row.workspaceId).catch(() => {
      throw new NotFoundException('작업을 찾을 수 없습니다');
    });
  }

  async forProject(auth: AuthContext, projectId: string): Promise<Access> {
    const row = await this.db.query.projects.findFirst({ where: eq(projects.id, projectId), columns: { workspaceId: true } });
    if (!row) throw new NotFoundException('프로젝트를 찾을 수 없습니다');
    return this.forWorkspace(auth, row.workspaceId).catch(() => {
      throw new NotFoundException('프로젝트를 찾을 수 없습니다');
    });
  }

  /** Effective level on every project of a workspace for one user (projects without access are left out). */
  async levelsFor(workspaceId: string, userId: string, role: WorkspaceRole, conn: Conn = this.db) {
    const list = await conn
      .select({ id: projects.id, memberAccess: projects.memberAccess })
      .from(projects)
      .where(eq(projects.workspaceId, workspaceId));
    const out = new Map<string, AccessLevel>();
    if (isWorkspaceAdmin(role)) {
      for (const p of list) out.set(p.id, 'manage');
      return out;
    }
    if (!list.length) return out;
    const [own, viaTeams] = await Promise.all([
      conn
        .select({ projectId: projectMembers.projectId, level: projectMembers.level })
        .from(projectMembers)
        .innerJoin(projects, eq(projects.id, projectMembers.projectId))
        .where(and(eq(projectMembers.userId, userId), eq(projects.workspaceId, workspaceId))),
      conn
        .select({ projectId: projectTeams.projectId, level: projectTeams.level })
        .from(projectTeams)
        .innerJoin(teams, eq(teams.id, projectTeams.teamId))
        .innerJoin(teamMembers, eq(teamMembers.teamId, teams.id))
        .where(and(eq(teamMembers.userId, userId), eq(teams.workspaceId, workspaceId))),
    ]);
    const grants = new Map<string, AccessLevel | null>();
    for (const g of [...own, ...viaTeams]) grants.set(g.projectId, maxLevel(grants.get(g.projectId), g.level));
    for (const p of list) {
      const level = maxLevel(p.memberAccess, grants.get(p.id));
      if (level) out.set(p.id, level);
    }
    return out;
  }

  /** Another member's level on one project (assignee checks, share dialog). */
  async userLevel(workspaceId: string, userId: string, projectId: string, conn: Conn = this.db) {
    const member = await this.membership(workspaceId, userId, conn);
    if (!member) return null;
    if (isWorkspaceAdmin(member.role)) return 'manage' as const;
    const levels = await this.levelsFor(workspaceId, userId, member.role, conn);
    return levels.get(projectId) ?? null;
  }

  /** Refresh after a change that affects the caller's own levels (e.g. they created a project). */
  async refresh(a: Access, conn: Conn = this.db): Promise<Access> {
    const levels = await this.levelsFor(a.workspaceId, a.userId, a.role, conn);
    return new Access(a.user, a.via, a.client, a.workspace, a.role, levels);
  }
}
