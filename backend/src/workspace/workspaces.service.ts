import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type {
  CreateInviteInput,
  Invite,
  InvitePreview,
  Member,
  Team,
  Workspace,
  WorkspaceRole,
  WorkspaceSummary,
} from '@obelisk/core';
import { and, asc, count, desc, eq, gt, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import type { AuthContext } from '../auth/auth.service';
import { randomToken, sha256 } from '../common/crypto';
import { InjectDb, type Db } from '../db/db.module';
import { ReservationsService } from '../migration/reservations.service';
import { ServerSettingsService } from '../server/settings.service';
import {
  invites,
  projectMembers,
  projects,
  tasks,
  teamMembers,
  teams,
  users,
  workspaceMembers,
  workspaces,
  type WorkspaceRow,
} from '../db/schema';
import { AccessService, type Access, type Conn } from './access.service';
import { ActivityService, diff } from './activity.service';
import { avatarPath } from './avatars.service';

const ROLE_ORDER: Record<WorkspaceRole, number> = { owner: 0, admin: 1, member: 2 };

function toSummary(ws: WorkspaceRow, role: WorkspaceRole, memberCount: number): WorkspaceSummary {
  return { id: ws.id, kind: ws.kind, name: ws.name, role, memberCount, avatarUrl: ws.kind === 'org' ? avatarPath(ws.avatarId) : null };
}

@Injectable()
export class WorkspacesService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly access: AccessService,
    private readonly activity: ActivityService,
    private readonly reservations: ReservationsService,
    private readonly settings: ServerSettingsService,
  ) {}

  // ───────────────────────────── workspaces

  /** Personal space first, then organizations in the order you joined them. */
  async listFor(userId: string): Promise<WorkspaceSummary[]> {
    await this.access.personalId(userId);
    const memberCount = sql<number>`(select count(*)::int from ${workspaceMembers} m where m.workspace_id = ${workspaces.id})`;
    const rows = await this.db
      .select({ ws: workspaces, role: workspaceMembers.role, joinedAt: workspaceMembers.createdAt, memberCount })
      .from(workspaceMembers)
      .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
      .where(eq(workspaceMembers.userId, userId))
      .orderBy(sql`case when ${workspaces.kind} = 'personal' then 0 else 1 end`, asc(workspaceMembers.createdAt));
    return rows.map((r) => toSummary(r.ws, r.role, r.memberCount));
  }

  async detail(a: Access): Promise<Workspace> {
    const [row] = await this.db
      .select({ n: count() })
      .from(workspaceMembers)
      .where(eq(workspaceMembers.workspaceId, a.workspaceId));
    return {
      ...toSummary(a.workspace, a.role, row?.n ?? 1),
      membersCanCreateProjects: a.workspace.membersCanCreateProjects,
      canCreateProjects: a.canCreateProjects,
      createdAt: a.workspace.createdAt.toISOString(),
    };
  }

  async create(auth: AuthContext, name: string): Promise<WorkspaceSummary> {
    if (!this.settings.canCreateOrg(await this.settings.row(), auth.user)) {
      throw new ForbiddenException('이 서버에서는 운영자만 조직을 만들 수 있어요');
    }
    const ws = await this.db.transaction(async (tx) => {
      const [ws] = await tx.insert(workspaces).values({ kind: 'org', name }).returning();
      await tx.insert(workspaceMembers).values({ workspaceId: ws!.id, userId: auth.user.id, role: 'owner' });
      const a = await this.access.forWorkspace(auth, ws!.id, tx);
      await this.activity.record(tx, a, { action: 'workspace.created', subject: name });
      return ws!;
    });
    return toSummary(ws, 'owner', 1);
  }

  async update(a: Access, input: { name?: string; membersCanCreateProjects?: boolean }) {
    a.assertOrg();
    a.assertAdmin('조직 설정 변경');
    const changes = diff(a.workspace, input, ['name', 'membersCanCreateProjects']);
    if (!Object.keys(changes).length) return;
    await this.db.transaction(async (tx) => {
      await tx.update(workspaces).set({ ...input, updatedAt: new Date() }).where(eq(workspaces.id, a.workspaceId));
      await this.activity.record(tx, a, { action: 'workspace.updated', subject: input.name ?? a.workspace.name, data: { changes } });
    });
  }

  /** Deletes the organization with every project, task and log in it. Owners only. */
  async remove(a: Access, confirmName: string) {
    a.assertOrg();
    if (!a.isOwner) throw new ForbiddenException('조직 삭제는 소유자만 할 수 있습니다');
    if (confirmName.trim() !== a.workspace.name) throw new BadRequestException('확인용 조직 이름이 일치하지 않습니다');
    await this.db.delete(workspaces).where(eq(workspaces.id, a.workspaceId));
    return { ok: true };
  }

  // ───────────────────────────── members

  async members(workspaceId: string, conn: Conn = this.db): Promise<Member[]> {
    const [rows, teamRows] = await Promise.all([
      conn
        .select({
          id: users.id,
          name: users.name,
          email: users.email,
          avatarId: users.avatarId,
          role: workspaceMembers.role,
          joinedAt: workspaceMembers.createdAt,
        })
        .from(workspaceMembers)
        .innerJoin(users, eq(users.id, workspaceMembers.userId))
        .where(eq(workspaceMembers.workspaceId, workspaceId)),
      conn
        .select({ teamId: teamMembers.teamId, userId: teamMembers.userId })
        .from(teamMembers)
        .innerJoin(teams, eq(teams.id, teamMembers.teamId))
        .where(eq(teams.workspaceId, workspaceId)),
    ]);
    return rows
      .map((r) => ({
        id: r.id,
        name: r.name,
        email: r.email,
        role: r.role,
        joinedAt: r.joinedAt.toISOString(),
        teamIds: teamRows.filter((t) => t.userId === r.id).map((t) => t.teamId),
        avatarUrl: avatarPath(r.avatarId),
      }))
      .sort((x, y) => ROLE_ORDER[x.role] - ROLE_ORDER[y.role] || x.name.localeCompare(y.name, 'ko'));
  }

  private async member(a: Access, userId: string, conn: Conn = this.db) {
    const row = await this.access.membership(a.workspaceId, userId, conn);
    if (!row) throw new NotFoundException('이 조직의 멤버가 아닙니다');
    const user = await conn.query.users.findFirst({ where: eq(users.id, userId) });
    return { ...row, name: user?.name ?? '알 수 없음' };
  }

  private async ownerCount(conn: Conn, workspaceId: string) {
    const [row] = await conn
      .select({ n: count() })
      .from(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.role, 'owner')));
    return row?.n ?? 0;
  }

  async updateMember(a: Access, userId: string, role: WorkspaceRole) {
    a.assertOrg();
    a.assertAdmin('멤버 역할 변경');
    await this.db.transaction(async (tx) => {
      // Serialize role changes in this workspace so two owners can't demote each other at once.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${a.workspaceId}))`);
      const target = await this.member(a, userId, tx);
      if (target.role === role) return;
      if ((target.role === 'owner' || role === 'owner') && !a.isOwner) {
        throw new ForbiddenException('소유자 지정과 해제는 소유자만 할 수 있습니다');
      }
      if (target.role === 'owner' && (await this.ownerCount(tx, a.workspaceId)) <= 1) {
        throw new BadRequestException('조직에는 소유자가 최소 한 명 있어야 합니다. 다른 사람을 먼저 소유자로 지정하세요.');
      }
      await tx
        .update(workspaceMembers)
        .set({ role })
        .where(and(eq(workspaceMembers.workspaceId, a.workspaceId), eq(workspaceMembers.userId, userId)));
      await this.activity.record(tx, a, {
        action: 'member.role',
        subject: target.name,
        data: { userId, from: target.role, to: role },
      });
    });
  }

  /** Remove someone, or leave (userId = yourself). Their grants and assignments here go with them. */
  async removeMember(a: Access, userId: string) {
    a.assertOrg();
    const self = userId === a.userId;
    if (!self) a.assertAdmin('멤버 내보내기');
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${a.workspaceId}))`);
      const target = await this.member(a, userId, tx);
      if (target.role === 'owner') {
        if (!self && !a.isOwner) throw new ForbiddenException('소유자는 다른 소유자만 내보낼 수 있습니다');
        if ((await this.ownerCount(tx, a.workspaceId)) <= 1) {
          throw new BadRequestException(
            self
              ? '마지막 소유자는 조직을 떠날 수 없습니다. 다른 사람을 소유자로 지정하거나 조직을 삭제하세요.'
              : '조직에는 소유자가 최소 한 명 있어야 합니다',
          );
        }
      }
      const wsProjects = tx.select({ id: projects.id }).from(projects).where(eq(projects.workspaceId, a.workspaceId));
      const wsTeams = tx.select({ id: teams.id }).from(teams).where(eq(teams.workspaceId, a.workspaceId));
      await tx.delete(projectMembers).where(and(eq(projectMembers.userId, userId), inArray(projectMembers.projectId, wsProjects)));
      await tx.delete(teamMembers).where(and(eq(teamMembers.userId, userId), inArray(teamMembers.teamId, wsTeams)));
      await tx
        .update(tasks)
        .set({ assigneeId: null, updatedAt: new Date() })
        .where(and(eq(tasks.workspaceId, a.workspaceId), eq(tasks.assigneeId, userId)));
      await tx
        .delete(workspaceMembers)
        .where(and(eq(workspaceMembers.workspaceId, a.workspaceId), eq(workspaceMembers.userId, userId)));
      await tx
        .update(users)
        .set({ defaultWorkspaceId: null })
        .where(and(eq(users.id, userId), eq(users.defaultWorkspaceId, a.workspaceId)));
      await this.activity.record(tx, a, { action: self ? 'member.left' : 'member.removed', subject: target.name, data: { userId } });
    });
    return { ok: true };
  }

  // ───────────────────────────── invite links

  async listInvites(a: Access): Promise<Invite[]> {
    a.assertOrg();
    a.assertAdmin('초대 링크 관리');
    const rows = await this.db
      .select({ inv: invites, by: users.name })
      .from(invites)
      .leftJoin(users, eq(users.id, invites.createdBy))
      .where(
        and(
          eq(invites.workspaceId, a.workspaceId),
          isNull(invites.revokedAt),
          or(isNull(invites.expiresAt), gt(invites.expiresAt, new Date())),
          or(isNull(invites.maxUses), lt(invites.uses, invites.maxUses)),
        ),
      )
      .orderBy(desc(invites.createdAt));
    return rows.map((r) => ({
      id: r.inv.id,
      role: r.inv.role,
      hint: r.inv.hint,
      expiresAt: r.inv.expiresAt?.toISOString() ?? null,
      maxUses: r.inv.maxUses,
      uses: r.inv.uses,
      createdBy: r.by,
      createdAt: r.inv.createdAt.toISOString(),
    }));
  }

  /** The link is shown exactly once; only its hash is stored. */
  async createInvite(a: Access, input: CreateInviteInput) {
    a.assertOrg();
    a.assertAdmin('초대 링크 만들기');
    const token = randomToken('obi', 24);
    const expiresAt = input.expiresInDays ? new Date(Date.now() + input.expiresInDays * 86_400_000) : null;
    const row = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(invites)
        .values({
          workspaceId: a.workspaceId,
          tokenHash: sha256(token),
          hint: token.slice(-4),
          role: input.role,
          createdBy: a.userId,
          expiresAt,
          maxUses: input.maxUses,
        })
        .returning();
      await this.activity.record(tx, a, {
        action: 'invite.created',
        subject: `…${row!.hint}`,
        data: { role: input.role, expiresInDays: input.expiresInDays, maxUses: input.maxUses },
      });
      return row!;
    });
    return {
      token,
      invite: {
        id: row.id,
        role: row.role,
        hint: row.hint,
        expiresAt: row.expiresAt?.toISOString() ?? null,
        maxUses: row.maxUses,
        uses: 0,
        createdBy: a.user.name,
        createdAt: row.createdAt.toISOString(),
      } satisfies Invite,
    };
  }

  async revokeInvite(a: Access, id: string) {
    a.assertOrg();
    a.assertAdmin('초대 링크 관리');
    await this.db.transaction(async (tx) => {
      const [row] = await tx
        .update(invites)
        .set({ revokedAt: new Date() })
        .where(and(eq(invites.id, id), eq(invites.workspaceId, a.workspaceId), isNull(invites.revokedAt)))
        .returning();
      if (!row) throw new NotFoundException('초대 링크를 찾을 수 없습니다');
      await this.activity.record(tx, a, { action: 'invite.revoked', subject: `…${row.hint}` });
    });
    return { ok: true };
  }

  private async inviteRow(token: string, conn: Conn = this.db) {
    const row = await conn.query.invites.findFirst({ where: eq(invites.tokenHash, sha256(token.trim())) });
    if (!row) throw new NotFoundException('초대 링크가 올바르지 않습니다');
    const reason: InvitePreview['reason'] = row.revokedAt
      ? 'revoked'
      : row.expiresAt && row.expiresAt < new Date()
        ? 'expired'
        : row.maxUses !== null && row.uses >= row.maxUses
          ? 'used_up'
          : undefined;
    return { row, reason };
  }

  async previewInvite(token: string, userId?: string): Promise<InvitePreview> {
    // Claim links of imported organizations (obr_…) go through the same page.
    if (this.reservations.isClaimToken(token)) return this.reservations.preview(token, userId);
    const { row, reason } = await this.inviteRow(token);
    const ws = await this.db.query.workspaces.findFirst({ where: eq(workspaces.id, row.workspaceId) });
    if (!ws) throw new NotFoundException('초대 링크가 올바르지 않습니다');
    const [[n], inviter, member] = await Promise.all([
      this.db.select({ n: count() }).from(workspaceMembers).where(eq(workspaceMembers.workspaceId, ws.id)),
      row.createdBy ? this.db.query.users.findFirst({ where: eq(users.id, row.createdBy) }) : undefined,
      userId ? this.access.membership(ws.id, userId) : undefined,
    ]);
    return {
      workspace: { id: ws.id, name: ws.name, memberCount: n?.n ?? 0, avatarUrl: avatarPath(ws.avatarId) },
      role: row.role,
      invitedBy: inviter?.name ?? null,
      valid: !reason,
      ...(reason ? { reason } : {}),
      ...(userId ? { alreadyMember: !!member } : {}),
    };
  }

  /** True when the token is a live invite (lets sign-up through even when SIGNUP_MODE closes it). */
  async inviteUsable(token: string, conn: Conn = this.db): Promise<boolean> {
    if (this.reservations.isClaimToken(token)) return this.reservations.usable(token, conn);
    try {
      return !(await this.inviteRow(token, conn)).reason;
    } catch {
      return false;
    }
  }

  /** Join through a link. Already a member: nothing changes (a claim link still hands over its claims). Returns the workspace id. */
  async acceptInvite(auth: AuthContext, token: string, conn?: Conn): Promise<string> {
    const run = async (tx: Conn) => {
      // A claim link joins as the reserved person, whatever email the account has: the link is the proof.
      if (this.reservations.isClaimToken(token)) return this.reservations.claim(tx, token, auth.user);
      const { row, reason } = await this.inviteRow(token, tx);
      if (await this.access.membership(row.workspaceId, auth.user.id, tx)) return row.workspaceId;
      if (reason) {
        throw new BadRequestException(
          reason === 'expired' ? '만료된 초대 링크입니다' : reason === 'revoked' ? '취소된 초대 링크입니다' : '사용 횟수가 끝난 초대 링크입니다',
        );
      }
      // Claim one use atomically so a single-use link can't be used twice at the same moment.
      const [claimed] = await tx
        .update(invites)
        .set({ uses: sql`${invites.uses} + 1` })
        .where(
          and(
            eq(invites.id, row.id),
            isNull(invites.revokedAt),
            or(isNull(invites.maxUses), lt(invites.uses, invites.maxUses)),
          ),
        )
        .returning();
      if (!claimed) throw new BadRequestException('사용 횟수가 끝난 초대 링크입니다');
      await tx.insert(workspaceMembers).values({ workspaceId: row.workspaceId, userId: auth.user.id, role: row.role }).onConflictDoNothing();
      const a = await this.access.forWorkspace(auth, row.workspaceId, tx);
      await this.activity.record(tx, a, { action: 'member.joined', subject: auth.user.name, data: { userId: auth.user.id, role: row.role, invite: row.hint } });
      return row.workspaceId;
    };
    return conn ? run(conn) : this.db.transaction(run);
  }

  // ───────────────────────────── teams

  async teams(workspaceId: string, conn: Conn = this.db): Promise<Team[]> {
    const [rows, links] = await Promise.all([
      conn.select().from(teams).where(eq(teams.workspaceId, workspaceId)).orderBy(asc(teams.name)),
      conn
        .select({ teamId: teamMembers.teamId, userId: teamMembers.userId })
        .from(teamMembers)
        .innerJoin(teams, eq(teams.id, teamMembers.teamId))
        .where(eq(teams.workspaceId, workspaceId)),
    ]);
    return rows.map((t) => ({
      id: t.id,
      name: t.name,
      memberIds: links.filter((l) => l.teamId === t.id).map((l) => l.userId),
      createdAt: t.createdAt.toISOString(),
    }));
  }

  private async assertMembers(conn: Conn, workspaceId: string, userIds: string[]) {
    if (!userIds.length) return;
    const rows = await conn
      .select({ userId: workspaceMembers.userId })
      .from(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, workspaceId), inArray(workspaceMembers.userId, userIds)));
    if (rows.length !== new Set(userIds).size) throw new BadRequestException('조직 멤버만 팀에 넣을 수 있습니다');
  }

  private async team(conn: Conn, a: Access, id: string) {
    const row = await conn.query.teams.findFirst({ where: and(eq(teams.id, id), eq(teams.workspaceId, a.workspaceId)) });
    if (!row) throw new NotFoundException('팀을 찾을 수 없습니다');
    return row;
  }

  private uniqueName(e: unknown): never {
    if ((e as { code?: string })?.code === '23505') throw new ConflictException('같은 이름의 팀이 이미 있습니다');
    throw e;
  }

  async createTeam(a: Access, input: { name: string; memberIds?: string[] }): Promise<Team> {
    a.assertOrg();
    a.assertAdmin('팀 만들기');
    const id = await this.db
      .transaction(async (tx) => {
        const memberIds = [...new Set(input.memberIds ?? [])];
        await this.assertMembers(tx, a.workspaceId, memberIds);
        const [row] = await tx.insert(teams).values({ workspaceId: a.workspaceId, name: input.name }).returning();
        if (memberIds.length) await tx.insert(teamMembers).values(memberIds.map((userId) => ({ teamId: row!.id, userId })));
        await this.activity.record(tx, a, { action: 'team.created', subject: input.name, data: { teamId: row!.id, members: memberIds.length } });
        return row!.id;
      })
      .catch((e) => this.uniqueName(e));
    return (await this.teams(a.workspaceId)).find((t) => t.id === id)!;
  }

  async updateTeam(a: Access, id: string, input: { name?: string; memberIds?: string[] }): Promise<Team> {
    a.assertOrg();
    a.assertAdmin('팀 수정');
    await this.db
      .transaction(async (tx) => {
        const cur = await this.team(tx, a, id);
        const data: Record<string, unknown> = { teamId: id };
        if (input.name !== undefined && input.name !== cur.name) {
          await tx.update(teams).set({ name: input.name }).where(eq(teams.id, id));
          data.renamed = { from: cur.name, to: input.name };
        }
        if (input.memberIds) {
          const next = [...new Set(input.memberIds)];
          await this.assertMembers(tx, a.workspaceId, next);
          const before = (await tx.select({ userId: teamMembers.userId }).from(teamMembers).where(eq(teamMembers.teamId, id))).map((r) => r.userId);
          const added = next.filter((u) => !before.includes(u));
          const removed = before.filter((u) => !next.includes(u));
          if (removed.length) await tx.delete(teamMembers).where(and(eq(teamMembers.teamId, id), inArray(teamMembers.userId, removed)));
          if (added.length) await tx.insert(teamMembers).values(added.map((userId) => ({ teamId: id, userId })));
          if (added.length || removed.length) Object.assign(data, { added, removed });
        }
        if (Object.keys(data).length > 1) await this.activity.record(tx, a, { action: 'team.updated', subject: input.name ?? cur.name, data });
      })
      .catch((e) => this.uniqueName(e));
    const team = (await this.teams(a.workspaceId)).find((t) => t.id === id);
    if (!team) throw new NotFoundException('팀을 찾을 수 없습니다');
    return team;
  }

  async removeTeam(a: Access, id: string) {
    a.assertOrg();
    a.assertAdmin('팀 삭제');
    await this.db.transaction(async (tx) => {
      const cur = await this.team(tx, a, id);
      await tx.delete(teams).where(eq(teams.id, id));
      await this.activity.record(tx, a, { action: 'team.deleted', subject: cur.name, data: { teamId: id } });
    });
    return { ok: true };
  }
}
