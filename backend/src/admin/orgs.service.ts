import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { AdminOrg, AdminOrgList, AdminOrgMember, AdminOrgOwner } from '@obelisk/core';
import { and, asc, desc, eq, ilike, inArray, sql } from 'drizzle-orm';
import { gateOf } from '../auth/auth.service';
import { InjectDb, type Db } from '../db/db.module';
import { users, workspaceMembers, workspaces, type UserRow } from '../db/schema';
import { AdminLogService } from '../server/log.service';
import { ActivityService } from '../workspace/activity.service';
import { avatarPath } from '../workspace/avatars.service';

const likeEscape = (q: string) => q.replace(/[\\%_]/g, (c) => `\\${c}`);

/** The outer row's id, spelled out (Drizzle writes a bare "id" in single-table selects, which the subqueries would misread). */
const WID = sql.raw('"workspaces"."id"');

/** No owner who can still sign in. */
const ownerless = sql`not exists (
  select 1 from ${workspaceMembers} m join ${users} u on u.id = m.user_id
  where m.workspace_id = ${WID} and m.role = 'owner' and u.suspended_at is null
)`;

/**
 * 서버 관리 → 조직: names and sizes only. The one thing an operator can do to an organization is
 * give an ownerless one (every owner suspended) an owner from its own members, so it isn't stuck.
 */
@Injectable()
export class AdminOrgsService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly log: AdminLogService,
    private readonly activity: ActivityService,
  ) {}

  async list(input: { q?: string; ownerless?: boolean; offset?: number; limit?: number }): Promise<AdminOrgList> {
    const q = input.q?.trim();
    const where = and(
      eq(workspaces.kind, 'org'),
      q ? ilike(workspaces.name, `%${likeEscape(q)}%`) : undefined,
      input.ownerless ? ownerless : undefined,
    );
    const members = sql<number>`(select count(*)::int from ${workspaceMembers} m where m.workspace_id = ${WID})`;
    const projectsN = sql<number>`(select count(*)::int from projects p where p.workspace_id = ${WID})`;
    const tasksN = sql<number>`(select count(*)::int from tasks t where t.workspace_id = ${WID})`;
    const [rows, [total], [stuck]] = await Promise.all([
      this.db
        .select({ ws: workspaces, members, projects: projectsN, tasks: tasksN, ownerless: sql<boolean>`${ownerless}` })
        .from(workspaces)
        .where(where)
        .orderBy(sql`${ownerless} desc`, desc(workspaces.createdAt))
        .offset(input.offset ?? 0)
        .limit(input.limit ?? 50),
      this.db.select({ n: sql<number>`count(*)::int` }).from(workspaces).where(where),
      this.db.select({ n: sql<number>`count(*)::int` }).from(workspaces).where(and(eq(workspaces.kind, 'org'), ownerless)),
    ]);
    const ids = rows.map((r) => r.ws.id);
    const owners = ids.length
      ? await this.db
          .select({ ws: workspaceMembers.workspaceId, id: users.id, name: users.name, email: users.email, suspendedAt: users.suspendedAt })
          .from(workspaceMembers)
          .innerJoin(users, eq(users.id, workspaceMembers.userId))
          .where(and(eq(workspaceMembers.role, 'owner'), inArray(workspaceMembers.workspaceId, ids)))
          .orderBy(asc(workspaceMembers.createdAt))
      : [];
    const byWs = new Map<string, AdminOrgOwner[]>();
    for (const o of owners) {
      const list = byWs.get(o.ws) ?? [];
      list.push({ id: o.id, name: o.name, email: o.email, suspended: !!o.suspendedAt });
      byWs.set(o.ws, list);
    }
    return {
      orgs: rows.map(
        (r): AdminOrg => ({
          id: r.ws.id,
          name: r.ws.name,
          avatarUrl: avatarPath(r.ws.avatarId),
          createdAt: r.ws.createdAt.toISOString(),
          members: r.members,
          owners: byWs.get(r.ws.id) ?? [],
          ownerless: !!r.ownerless,
          projects: r.projects,
          tasks: r.tasks,
        }),
      ),
      total: total?.n ?? 0,
      ownerless: stuck?.n ?? 0,
    };
  }

  private async org(id: string) {
    const ws = await this.db.query.workspaces.findFirst({ where: and(eq(workspaces.id, id), eq(workspaces.kind, 'org')) });
    if (!ws) throw new NotFoundException('조직을 찾을 수 없어요');
    return ws;
  }

  /** Who could be named owner: the organization's members (names and addresses only). */
  async members(id: string): Promise<AdminOrgMember[]> {
    await this.org(id);
    const rows = await this.db
      .select({ id: users.id, name: users.name, email: users.email, role: workspaceMembers.role, suspendedAt: users.suspendedAt })
      .from(workspaceMembers)
      .innerJoin(users, eq(users.id, workspaceMembers.userId))
      .where(eq(workspaceMembers.workspaceId, id))
      .orderBy(sql`case ${workspaceMembers.role} when 'owner' then 0 when 'admin' then 1 else 2 end`, asc(users.name));
    return rows.map((r) => ({ id: r.id, name: r.name, email: r.email, role: r.role, suspended: !!r.suspendedAt }));
  }

  async setOwner(actor: UserRow, orgId: string, userId: string): Promise<void> {
    const ws = await this.org(orgId);
    await this.db.transaction(async (tx) => {
      // The same lock as role changes inside the organization.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${ws.id}))`);
      const [stuck] = await tx
        .select({ yes: sql<boolean>`${ownerless}` })
        .from(workspaces)
        .where(eq(workspaces.id, ws.id));
      if (!stuck?.yes) throw new BadRequestException('소유자가 있는 조직이에요. 소유자는 조직 안에서 정해요.');
      const [m] = await tx
        .select({ role: workspaceMembers.role, user: users })
        .from(workspaceMembers)
        .innerJoin(users, eq(users.id, workspaceMembers.userId))
        .where(and(eq(workspaceMembers.workspaceId, ws.id), eq(workspaceMembers.userId, userId)));
      if (!m) throw new NotFoundException('이 조직의 멤버가 아니에요');
      if (m.user.suspendedAt || gateOf(m.user)) throw new BadRequestException('지금 쓸 수 있는 계정만 소유자로 지정할 수 있어요');
      await tx
        .update(workspaceMembers)
        .set({ role: 'owner' })
        .where(and(eq(workspaceMembers.workspaceId, ws.id), eq(workspaceMembers.userId, userId)));
      // The organization's own log shows it too, so its members know how the owner came to be.
      await this.activity.recordIn(tx, { user: actor, via: 'session', client: null }, ws.id, {
        action: 'member.role',
        subject: m.user.name,
        data: { userId, from: m.role, to: 'owner', byOperator: true },
      });
      await this.log.record(tx, actor, 'org.owner_set', { id: ws.id, label: ws.name }, { userId, userName: m.user.name, userEmail: m.user.email });
    });
  }
}
