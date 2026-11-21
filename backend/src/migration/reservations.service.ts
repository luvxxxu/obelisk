import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { InvitePreview, MemberReservation } from '@obelisk/core';
import { and, asc, count, eq, inArray, isNull, not, sql } from 'drizzle-orm';
import { hasAssignee } from '../planner/assignees';
import type { AuthContext } from '../auth/auth.service';
import { randomToken, sha256 } from '../common/crypto';
import { actionMail, mailAvailable, sendMail } from '../common/mail';
import { config } from '../config';
import { InjectDb, type Db } from '../db/db.module';
import {
  activity,
  memberReservations,
  projectMembers,
  projects,
  tasks,
  teamMembers,
  teams,
  users,
  webhooks,
  workspaceMembers,
  workspaces,
  type AccessLevel,
  type MemberReservationRow,
  type ReservationClaims,
  type UserRow,
} from '../db/schema';
import type { Access, Conn } from '../workspace/access.service';
import { ActivityService } from '../workspace/activity.service';
import { avatarPath } from '../workspace/avatars.service';

/** Claim links start with this; the invite endpoints hand them here. */
export const RESERVATION_PREFIX = 'obr_';

export const emptyClaims = (): ReservationClaims => ({
  projects: [],
  teams: [],
  assigned: [],
  created: [],
  projectsCreated: [],
  activity: [],
  webhooks: [],
});

const RANK: Record<AccessLevel, number> = { view: 1, edit: 2, manage: 3 };

/** Large id lists go to Postgres in pieces (a statement takes at most 65k parameters). */
function chunks<T>(list: T[], size = 5000): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/**
 * People of an imported organization who haven't joined here yet. Their grants, assignments and
 * authorship wait in `claims` until they join. Two ways in: the claim link an admin hands them (copied,
 * or mailed to the reserved address: opening it proves they received it), or confirming that very
 * address on an account here (the mailbox proves it). An account that merely signed up with the same
 * email is only noted (matched_user_id): sign-up alone doesn't prove the address, and an admin can't
 * tell whose account it really is.
 */
@Injectable()
export class ReservationsService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly activity: ActivityService,
  ) {}

  isClaimToken(token: string): boolean {
    return token.trim().startsWith(RESERVATION_PREFIX);
  }

  private byToken(token: string, conn: Conn = this.db) {
    return conn.query.memberReservations.findFirst({ where: eq(memberReservations.tokenHash, sha256(token.trim())) });
  }

  /** True when the claim link still works (lets sign-up through even when SIGNUP_MODE closes it). */
  async usable(token: string, conn: Conn = this.db): Promise<boolean> {
    return !!(await this.byToken(token, conn));
  }

  /** What /invite/obr_… shows before anyone joins. */
  async preview(token: string, userId?: string): Promise<InvitePreview> {
    const r = await this.byToken(token);
    if (!r) throw new NotFoundException('가입 링크가 만료됐거나 이미 쓰였어요');
    const ws = await this.db.query.workspaces.findFirst({ where: eq(workspaces.id, r.workspaceId) });
    if (!ws) throw new NotFoundException('가입 링크가 만료됐거나 이미 쓰였어요');
    const [[n], inviter, member] = await Promise.all([
      this.db.select({ n: count() }).from(workspaceMembers).where(eq(workspaceMembers.workspaceId, ws.id)),
      r.createdBy ? this.db.query.users.findFirst({ where: eq(users.id, r.createdBy) }) : undefined,
      userId
        ? this.db.query.workspaceMembers.findFirst({
            where: and(eq(workspaceMembers.workspaceId, ws.id), eq(workspaceMembers.userId, userId)),
          })
        : undefined,
    ]);
    return {
      workspace: { id: ws.id, name: ws.name, memberCount: n?.n ?? 0, avatarUrl: avatarPath(ws.avatarId) },
      role: r.role,
      invitedBy: inviter?.name ?? null,
      valid: true,
      reservation: { name: r.name, email: r.email },
      ...(userId ? { alreadyMember: !!member } : {}),
    };
  }

  /**
   * Join through a claim link (signed in or signing up, already a member or not): the link itself is
   * the proof. Returns the workspace id.
   * Locks in the same order as membership changes and account deletion — the workspace first, then
   * the reservation row — so the two can't deadlock.
   */
  async claim(tx: Conn, token: string, user: UserRow): Promise<string> {
    const gone = () => new BadRequestException('가입 링크가 만료됐거나 이미 쓰였어요');
    const hash = sha256(token.trim());
    const found = await this.byToken(token, tx);
    if (!found) throw gone();
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${found.workspaceId}))`);
    await tx.execute(sql`select 1 from ${memberReservations} where ${memberReservations.id} = ${found.id} for update`);
    // Re-read under the lock: it may have been claimed, cancelled or given a new link meanwhile.
    const r = await tx.query.memberReservations.findFirst({ where: eq(memberReservations.id, found.id) });
    if (!r || r.tokenHash !== hash) throw gone();
    await this.activate(tx, r, user, 'session');
    return r.workspaceId;
  }

  /**
   * A new account whose email matches a reservation: noted so admins know the person is here and can
   * send the claim link. It never joins by itself. Runs after the sign-up's own invite or claim (which
   * take the workspace lock first), and takes only row locks.
   */
  async matchEmail(tx: Conn, user: UserRow) {
    await tx
      .update(memberReservations)
      .set({ matchedUserId: user.id })
      .where(and(eq(memberReservations.email, user.email.toLowerCase()), isNull(memberReservations.matchedUserId)));
  }

  /**
   * An account just confirmed its address: every place reserved for that address is theirs, as if
   * they had opened the claim link (the mailbox is the proof). Suspended accounts wait. Returns how
   * many organizations they joined.
   */
  async claimVerified(tx: Conn, user: UserRow, opts: { workspaceId?: string } = {}): Promise<number> {
    if (!user.emailVerifiedAt || user.suspendedAt) return 0;
    const email = user.email.toLowerCase();
    const found = await tx
      .select({ id: memberReservations.id, workspaceId: memberReservations.workspaceId })
      .from(memberReservations)
      .where(
        and(
          eq(memberReservations.email, email),
          opts.workspaceId ? eq(memberReservations.workspaceId, opts.workspaceId) : undefined,
        ),
      )
      .orderBy(asc(memberReservations.workspaceId));
    let joined = 0;
    for (const f of found) {
      // Same order as claim(): the workspace lock, then the row.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${f.workspaceId}))`);
      await tx.execute(sql`select 1 from ${memberReservations} where ${memberReservations.id} = ${f.id} for update`);
      const r = await tx.query.memberReservations.findFirst({ where: eq(memberReservations.id, f.id) });
      if (!r || r.email !== email) continue;
      await this.activate(tx, r, user, 'session', { verifiedEmail: true });
      joined++;
    }
    return joined;
  }

  /**
   * Give U everything the reservation held: membership with its role, team memberships, project
   * grants (the higher level wins), and authorship/assignment of the rows the import left empty.
   * Then the reservation is gone, so its link stops working.
   */
  async activate(tx: Conn, r: MemberReservationRow, user: UserRow, via: AuthContext['via'], extra: Record<string, unknown> = {}) {
    // Callers hold it already (taken before the row lock); taking it again in the same transaction is free.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${r.workspaceId}))`);
    const c = { ...emptyClaims(), ...r.claims };
    // Someone already in keeps their role: changing it is a separate, deliberate admin action.
    const [added] = await tx
      .insert(workspaceMembers)
      .values({ workspaceId: r.workspaceId, userId: user.id, role: r.role })
      .onConflictDoNothing()
      .returning({ role: workspaceMembers.role });
    const role =
      added?.role ??
      (
        await tx.query.workspaceMembers.findFirst({
          where: and(eq(workspaceMembers.workspaceId, r.workspaceId), eq(workspaceMembers.userId, user.id)),
        })
      )?.role ??
      r.role;

    if (c.teams.length) {
      const live = await tx
        .select({ id: teams.id })
        .from(teams)
        .where(and(eq(teams.workspaceId, r.workspaceId), inArray(teams.id, c.teams)));
      if (live.length) await tx.insert(teamMembers).values(live.map((t) => ({ teamId: t.id, userId: user.id }))).onConflictDoNothing();
    }

    if (c.projects.length) {
      const live = new Set(
        (
          await tx
            .select({ id: projects.id })
            .from(projects)
            .where(and(eq(projects.workspaceId, r.workspaceId), inArray(projects.id, c.projects.map((p) => p.projectId))))
        ).map((p) => p.id),
      );
      const had = new Map(
        (
          live.size === 0
            ? []
            : await tx
            .select({ projectId: projectMembers.projectId, level: projectMembers.level })
            .from(projectMembers)
            .where(and(eq(projectMembers.userId, user.id), inArray(projectMembers.projectId, [...live])))
        ).map((g) => [g.projectId, g.level]),
      );
      for (const g of c.projects) {
        if (!live.has(g.projectId)) continue;
        const cur = had.get(g.projectId);
        if (!cur) {
          await tx.insert(projectMembers).values({ projectId: g.projectId, userId: user.id, level: g.level }).onConflictDoNothing();
          had.set(g.projectId, g.level);
        } else if (RANK[g.level] > RANK[cur]) {
          await tx
            .update(projectMembers)
            .set({ level: g.level })
            .where(and(eq(projectMembers.projectId, g.projectId), eq(projectMembers.userId, user.id)));
          had.set(g.projectId, g.level);
        }
      }
    }

    const ws = r.workspaceId;
    for (const ids of chunks(c.assigned)) {
      await tx
        .update(tasks)
        .set({ assigneeIds: sql`array_append(${tasks.assigneeIds}, ${user.id}::uuid)` })
        .where(and(eq(tasks.workspaceId, ws), inArray(tasks.id, ids), not(hasAssignee(user.id)), sql`cardinality(${tasks.assigneeIds}) < 20`));
    }
    for (const ids of chunks(c.created)) {
      await tx.update(tasks).set({ createdBy: user.id }).where(and(eq(tasks.workspaceId, ws), inArray(tasks.id, ids), isNull(tasks.createdBy)));
    }
    for (const ids of chunks(c.projectsCreated)) {
      await tx
        .update(projects)
        .set({ createdBy: user.id })
        .where(and(eq(projects.workspaceId, ws), inArray(projects.id, ids), isNull(projects.createdBy)));
    }
    for (const ids of chunks(c.webhooks)) {
      await tx
        .update(webhooks)
        .set({ createdBy: user.id })
        .where(and(eq(webhooks.workspaceId, ws), inArray(webhooks.id, ids), isNull(webhooks.createdBy)));
    }
    for (const ids of chunks(c.activity)) {
      await tx
        .update(activity)
        .set({ actorId: user.id })
        .where(and(eq(activity.workspaceId, ws), inArray(activity.id, ids), isNull(activity.actorId)));
    }

    await tx.delete(memberReservations).where(eq(memberReservations.id, r.id));
    await this.activity.recordIn(tx, { user, via, client: null }, ws, {
      action: 'member.joined',
      subject: user.name,
      data: { userId: user.id, role, reservation: true, ...(added ? {} : { alreadyMember: true }), ...extra },
    });
  }

  // ───────────────────────────── admins (조직 설정 → 멤버 → 가입 대기)

  async list(a: Access): Promise<{ reservations: MemberReservation[]; mailEnabled: boolean }> {
    a.assertOrg();
    a.assertAdmin('가입 대기 관리');
    const rows = await this.db
      .select({ r: memberReservations, account: users.id })
      .from(memberReservations)
      .leftJoin(users, eq(users.id, memberReservations.matchedUserId))
      .where(eq(memberReservations.workspaceId, a.workspaceId))
      .orderBy(asc(memberReservations.name), asc(memberReservations.email));
    return {
      reservations: rows.map(({ r, account }) => ({
        id: r.id,
        email: r.email,
        name: r.name,
        role: r.role,
        status: r.matchedUserId && account ? 'signed_up' : 'waiting',
        former: !!r.claims.former,
        hasLink: !!r.tokenHash,
        createdAt: r.createdAt.toISOString(),
      })),
      mailEnabled: mailAvailable(),
    };
  }

  private async row(a: Access, id: string, conn: Conn = this.db) {
    a.assertOrg();
    a.assertAdmin('가입 대기 관리');
    const r = await conn.query.memberReservations.findFirst({
      where: and(eq(memberReservations.id, id), eq(memberReservations.workspaceId, a.workspaceId)),
    });
    if (!r) throw new NotFoundException('가입 대기 중인 사람을 찾을 수 없어요');
    // Admins can't make owners elsewhere either.
    if (r.role === 'owner' && !a.isOwner) throw new ForbiddenException('소유자 자리는 소유자만 처리할 수 있어요');
    return r;
  }

  /** A new claim link; the previous one stops working. The link is shown once, only its hash is kept. */
  async rotateLink(a: Access, id: string): Promise<{ link: string; row: MemberReservationRow }> {
    const r = await this.row(a, id);
    return { link: await this.rotate(r.id), row: r };
  }

  /** Fails when the reservation was claimed or cancelled in the meantime, so no dead link goes out. */
  private async rotate(id: string): Promise<string> {
    const token = randomToken('obr', 24);
    const [hit] = await this.db
      .update(memberReservations)
      .set({ tokenHash: sha256(token), tokenHint: token.slice(-4) })
      .where(eq(memberReservations.id, id))
      .returning({ id: memberReservations.id });
    if (!hit) throw new NotFoundException('가입 대기 중인 사람을 찾을 수 없어요');
    return `${config.publicUrl}/invite/${token}`;
  }

  private send(a: Access, row: Pick<MemberReservationRow, 'email' | 'name'>, link: string) {
    const mail = actionMail({
      to: row.email,
      subject: `${a.workspace.name} 조직에 합류하세요`,
      heading: `${a.workspace.name} 조직이 이 서버로 옮겨 왔어요`,
      lines: [
        `${row.name}님, ${a.user.name}님이 ${a.workspace.name} 조직을 다른 Obelisk 서버에서 이곳으로 옮겼어요.`,
        '아래 버튼을 눌러 계정을 만들거나 로그인하면, 맡고 있던 작업과 프로젝트 권한이 그대로 이어져요. 링크는 한 번만 쓸 수 있어요.',
      ],
      action: '조직에 합류하기',
      url: link,
      footer: '모르는 조직이라면 이 메일은 무시하세요.',
    });
    void sendMail(mail).catch((err) => console.error(`[mail] reservation mail failed: ${(err as Error).message}`));
  }

  async mail(a: Access, id: string) {
    if (!mailAvailable()) throw new BadRequestException('메일 서버가 설정되지 않았어요');
    const { link, row } = await this.rotateLink(a, id);
    this.send(a, row, link);
    return { ok: true };
  }

  /**
   * A fresh claim link to every reserved address at once (after an import). Owner places only when
   * an owner asks; former members are left out — they had left, so asking them back is a choice made
   * one by one.
   */
  async mailAll(a: Access): Promise<{ sent: number }> {
    a.assertOrg();
    a.assertAdmin('가입 대기 관리');
    if (!mailAvailable()) throw new BadRequestException('메일 서버가 설정되지 않았어요');
    const rows = await this.db.select().from(memberReservations).where(eq(memberReservations.workspaceId, a.workspaceId));
    let sent = 0;
    for (const r of rows) {
      if (r.claims.former || (r.role === 'owner' && !a.isOwner)) continue;
      let link: string;
      try {
        link = await this.rotate(r.id);
      } catch {
        continue; // claimed or cancelled meanwhile
      }
      this.send(a, r, link);
      sent++;
    }
    return { sent };
  }

  async remove(a: Access, id: string) {
    const r = await this.row(a, id);
    await this.db.delete(memberReservations).where(eq(memberReservations.id, r.id));
    return { ok: true };
  }
}
