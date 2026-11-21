import { ForbiddenException, Injectable, NotFoundException, PayloadTooLargeException } from '@nestjs/common';
import {
  MIGRATION_FORMAT,
  MIGRATION_MAX_BYTES,
  MIGRATION_VERSION,
  type MigrationBundleInput,
  type MigrationPhoto,
  type MigrationSecrets,
  workHoursOf,
} from '@obelisk/core';
import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { unseal } from '../common/secret';
import { config } from '../config';
import { InjectDb, type Db } from '../db/db.module';
import {
  activity,
  apiTokens,
  avatars,
  incomingWebhooks,
  memberReservations,
  projectMembers,
  projects,
  projectTeams,
  taskDependencies,
  tasks,
  timeBlocks,
  timeEntries,
  teamMembers,
  teams,
  users,
  webhooks,
  workspaceMembers,
  workspaces,
  type UserRow,
  type WorkspaceRow,
} from '../db/schema';
import { jevKeyContext } from '../jev/status';
import { secretContext } from '../webhooks/delivery.service';
import type { Conn } from '../workspace/access.service';
import { lockSecrets } from './secrets';

const tooLarge = () => new PayloadTooLargeException('내보낼 데이터가 64MB를 넘어요. 오래된 기록이나 사진을 줄인 뒤 다시 시도하세요');

/** Groups rows by a key (instead of filtering the whole list once per project or team). */
function groupBy<T, K>(rows: T[], key: (r: T) => K): Map<K, T[]> {
  const out = new Map<K, T[]>();
  for (const r of rows) {
    const k = key(r);
    const list = out.get(k);
    if (list) list.push(r);
    else out.set(k, [r]);
  }
  return out;
}

export type SecretsMode = { mode: 'none' } | { mode: 'plain' } | { mode: 'locked'; passphrase: string };

const iso = (d: Date) => d.toISOString();
const isoOrNull = (d: Date | null) => (d ? d.toISOString() : null);

/**
 * Writes a workspace as a bundle (packages/core migration.ts). Reads everything in it straight
 * from the database, without the usual per-project scoping: only the owner of an organization,
 * or the person a personal space belongs to, may do this.
 */
@Injectable()
export class ExportService {
  constructor(@InjectDb() private readonly db: Db) {}

  /** The workspace if `userId` may export it: their own personal space, or an organization they own. */
  async exportable(userId: string, workspaceId: string, conn: Conn = this.db): Promise<WorkspaceRow> {
    const [row] = await conn
      .select({ ws: workspaces, role: workspaceMembers.role })
      .from(workspaces)
      .innerJoin(workspaceMembers, and(eq(workspaceMembers.workspaceId, workspaces.id), eq(workspaceMembers.userId, userId)))
      .where(eq(workspaces.id, workspaceId))
      .limit(1);
    if (!row) throw new NotFoundException('공간을 찾을 수 없거나 멤버가 아닙니다');
    if (row.ws.kind === 'personal' ? row.ws.personalUserId !== userId : row.role !== 'owner') {
      throw new ForbiddenException('조직 소유자만 내보낼 수 있어요');
    }
    return row.ws;
  }

  private async photo(id: string | null): Promise<MigrationPhoto | null> {
    if (!id) return null;
    const row = await this.db.query.avatars.findFirst({ where: eq(avatars.id, id) });
    if (!row) return null;
    return { contentType: row.contentType as MigrationPhoto['contentType'], data: Buffer.from(row.data).toString('base64') };
  }

  /**
   * Refuses early (413) when the workspace's text alone is already over the limit, before anything
   * is loaded into memory. A lower bound: the exact size is checked again on the finished JSON.
   */
  async assertFits(workspaceId: string, conn: Conn = this.db) {
    const [row] = await conn.execute<{ bytes: string | number | null }>(sql`
      select
        (select coalesce(sum(octet_length(${tasks.title}) + octet_length(${tasks.notes})), 0) from ${tasks} where ${tasks.workspaceId} = ${workspaceId})
        + (select coalesce(sum(octet_length(${activity.subject}) + octet_length(${activity.actorName}) + octet_length(coalesce(${activity.data}::text, ''))), 0)
           from ${activity} where ${activity.workspaceId} = ${workspaceId})
        as bytes`);
    if (Number(row?.bytes ?? 0) > MIGRATION_MAX_BYTES) throw tooLarge();
  }

  /** The bundle as JSON text (so its size is known before anything is sent). */
  async build(user: UserRow, workspaceId: string, secrets: SecretsMode): Promise<{ json: string; bundle: MigrationBundleInput; ws: WorkspaceRow }> {
    const ws = await this.exportable(user.id, workspaceId);
    await this.assertFits(ws.id);
    const personal = ws.kind === 'personal';
    const db = this.db;

    const [members, teamRows, projectRows, taskRows, depRows, activityRows, hookRows, incomingRows] = await Promise.all([
      db
        .select({ id: users.id, email: users.email, name: users.name, role: workspaceMembers.role })
        .from(workspaceMembers)
        .innerJoin(users, eq(users.id, workspaceMembers.userId))
        .where(eq(workspaceMembers.workspaceId, ws.id)),
      db.select().from(teams).where(eq(teams.workspaceId, ws.id)).orderBy(asc(teams.createdAt)),
      db.select().from(projects).where(eq(projects.workspaceId, ws.id)).orderBy(asc(projects.position)),
      db.select().from(tasks).where(eq(tasks.workspaceId, ws.id)).orderBy(asc(tasks.number)),
      db.select().from(taskDependencies).where(eq(taskDependencies.workspaceId, ws.id)),
      db.select().from(activity).where(eq(activity.workspaceId, ws.id)).orderBy(asc(activity.createdAt)),
      db.select().from(webhooks).where(eq(webhooks.workspaceId, ws.id)).orderBy(asc(webhooks.createdAt)),
      db.select().from(incomingWebhooks).where(eq(incomingWebhooks.workspaceId, ws.id)).orderBy(asc(incomingWebhooks.createdAt)),
    ]);
    const [entryRows, blockRows] = await Promise.all([
      db.select().from(timeEntries).where(eq(timeEntries.workspaceId, ws.id)).orderBy(asc(timeEntries.startedAt)),
      // Day plans are personal: only a personal space carries its owner's.
      personal ? db.select().from(timeBlocks).where(and(eq(timeBlocks.workspaceId, ws.id), eq(timeBlocks.userId, user.id))) : [],
    ]);
    const teamIds = teamRows.map((t) => t.id);
    const projectIds = projectRows.map((p) => p.id);
    const [teamLinks, memberGrants, teamGrants, reservations] = await Promise.all([
      teamIds.length ? db.select().from(teamMembers).where(inArray(teamMembers.teamId, teamIds)) : [],
      projectIds.length ? db.select().from(projectMembers).where(inArray(projectMembers.projectId, projectIds)) : [],
      projectIds.length ? db.select().from(projectTeams).where(inArray(projectTeams.projectId, projectIds)) : [],
      personal ? [] : db.select().from(memberReservations).where(eq(memberReservations.workspaceId, ws.id)).orderBy(asc(memberReservations.createdAt)),
    ]);

    // A personal space has exactly one person; an organization lists its members (the exporter is an owner).
    const people: MigrationBundleInput['people'] = personal
      ? [{ id: user.id, email: user.email, name: user.name, role: 'owner' as const }]
      : members.map((m) => ({ id: m.id, email: m.email, name: m.name, role: m.role }));
    const formerPeople: NonNullable<MigrationBundleInput['formerPeople']> = [];

    // People still waiting in 가입 대기 here (this organization was itself imported) travel on as people,
    // under their reservation's id, with what they will claim written back into the rows. Someone whose
    // email is also a member's is that member.
    const memberByEmail = new Map(people.map((p) => [p.email.toLowerCase(), p.id]));
    const extra = {
      teams: new Map<string, string[]>(),
      grants: new Map<string, { person: string; level: 'view' | 'edit' | 'manage' }[]>(),
      assignees: new Map<string, string[]>(),
      taskCreator: new Map<string, string>(),
      projectCreator: new Map<string, string>(),
      hookCreator: new Map<string, string>(),
      actor: new Map<string, string>(),
    };
    for (const r of reservations) {
      const person = memberByEmail.get(r.email.toLowerCase()) ?? r.id;
      if (person === r.id) {
        if (r.claims.former) formerPeople.push({ id: r.id, email: r.email, name: r.name });
        else people.push({ id: r.id, email: r.email, name: r.name, role: r.role });
        memberByEmail.set(r.email.toLowerCase(), r.id);
      }
      const c = r.claims;
      for (const t of c.teams ?? []) extra.teams.set(t, [...(extra.teams.get(t) ?? []), person]);
      for (const g of c.projects ?? []) extra.grants.set(g.projectId, [...(extra.grants.get(g.projectId) ?? []), { person, level: g.level }]);
      for (const id of c.assigned ?? []) extra.assignees.set(id, [...(extra.assignees.get(id) ?? []), person]);
      for (const id of c.created ?? []) extra.taskCreator.set(id, person);
      for (const id of c.projectsCreated ?? []) extra.projectCreator.set(id, person);
      for (const id of c.webhooks ?? []) extra.hookCreator.set(id, person);
      for (const id of c.activity ?? []) extra.actor.set(id, person);
    }

    // People who left but are still named on rows: for the record only (never members on the target).
    if (!personal) {
      const known = new Set([...people.map((p) => p.id), ...formerPeople.map((p) => p.id)]);
      const referenced = new Set<string>();
      const ids0 = [
        ...taskRows.flatMap((t) => [t.createdBy, ...t.assigneeIds]),
        ...projectRows.map((p) => p.createdBy),
        ...hookRows.map((h) => h.createdBy),
        ...incomingRows.map((h) => h.createdBy),
        ...activityRows.map((e) => e.actorId),
      ];
      for (const id of ids0) if (id && !known.has(id)) referenced.add(id);
      const ids = [...referenced];
      for (let i = 0; i < ids.length; i += 1000) {
        const part = ids.slice(i, i + 1000);
        for (const u of await db.select({ id: users.id, email: users.email, name: users.name }).from(users).where(inArray(users.id, part))) {
          if (memberByEmail.has(u.email.toLowerCase())) continue;
          formerPeople.push({ id: u.id, email: u.email, name: u.name });
          memberByEmail.set(u.email.toLowerCase(), u.id);
        }
      }
    }
    const linksByTeam = groupBy(teamLinks, (l) => l.teamId);
    const grantsByProject = groupBy(memberGrants, (g) => g.projectId);
    const teamGrantsByProject = groupBy(teamGrants, (g) => g.projectId);

    let account: MigrationBundleInput['account'] = null;
    const secretData: MigrationSecrets = { jevKey: null, webhooks: {} };
    if (personal) {
      const tokens = await db
        .select()
        .from(apiTokens)
        .where(and(eq(apiTokens.userId, user.id), isNull(apiTokens.revokedAt)))
        .orderBy(asc(apiTokens.createdAt));
      const jevKey = user.jevKey ? (unseal(user.jevKey, jevKeyContext(user.id))?.value ?? null) : null;
      secretData.jevKey = jevKey;
      account = {
        timezone: user.timezone,
        homeLayout: user.homeLayout ?? null,
        workHours: user.workHours ? workHoursOf(user.workHours) : null,
        photo: await this.photo(user.avatarId),
        wasDefault: user.defaultWorkspaceId === ws.id,
        jev: {
          baseUrl: user.jevBaseUrl,
          model: user.jevModel,
          autoApply: user.jevAutoApply,
          keyHint: user.jevKey ? user.jevKeyHint : null,
          hasKey: !!jevKey,
        },
        // Names only: a token (or its hash) never leaves this server, the new one is made there.
        apiTokens: tokens.map((t) => ({
          name: t.name,
          createdAt: iso(t.createdAt),
          lastUsedAt: isoOrNull(t.lastUsedAt),
        })),
      };
    }
    for (const h of hookRows) {
      const opened = unseal(h.secret, secretContext(h.id));
      if (opened) secretData.webhooks[h.id] = opened.value;
    }

    const exportId = randomUUID();
    const bundle: MigrationBundleInput = {
      format: MIGRATION_FORMAT,
      version: MIGRATION_VERSION,
      exportId,
      exportedAt: new Date().toISOString(),
      source: { url: config.publicUrl },
      kind: ws.kind,
      exporterId: user.id,
      workspace: {
        id: ws.id,
        name: ws.name,
        taskSeq: ws.taskSeq,
        membersCanCreateProjects: ws.membersCanCreateProjects,
        createdAt: iso(ws.createdAt),
        photo: personal ? null : await this.photo(ws.avatarId),
      },
      people,
      formerPeople,
      teams: teamRows.map((t) => ({
        id: t.id,
        name: t.name,
        createdAt: iso(t.createdAt),
        members: [...new Set([...(linksByTeam.get(t.id) ?? []).map((l) => l.userId), ...(extra.teams.get(t.id) ?? [])])],
      })),
      projects: projectRows.map((p) => ({
        id: p.id,
        name: p.name,
        color: p.color,
        position: p.position,
        memberAccess: p.memberAccess,
        archivedAt: isoOrNull(p.archivedAt),
        createdBy: p.createdBy ?? extra.projectCreator.get(p.id) ?? null,
        createdAt: iso(p.createdAt),
        updatedAt: iso(p.updatedAt),
        members: [
          ...(grantsByProject.get(p.id) ?? []).map((g) => ({ person: g.userId, level: g.level })),
          ...(extra.grants.get(p.id) ?? []),
        ],
        teams: (teamGrantsByProject.get(p.id) ?? []).map((g) => ({ team: g.teamId, level: g.level })),
      })),
      tasks: taskRows.map((t) => ({
        id: t.id,
        number: t.number,
        project: t.projectId,
        title: t.title,
        notes: t.notes,
        status: t.status,
        priority: t.priority as 0 | 1 | 2 | 3,
        startDate: t.startDate,
        dueDate: t.dueDate,
        startTime: t.startDate ? t.startTime : null,
        dueTime: t.dueDate ? t.dueTime : null,
        fixed: t.fixed,
        estimateMinutes: t.estimateMinutes,
        actualMinutes: t.actualMinutes,
        firstDueDate: t.firstDueDate,
        position: t.position,
        postponedCount: t.postponedCount,
        completedAt: isoOrNull(t.completedAt),
        createdAt: iso(t.createdAt),
        updatedAt: iso(t.updatedAt),
        createdBy: t.createdBy ?? extra.taskCreator.get(t.id) ?? null,
        // Reserved people (no account here yet) are kept on the claim, not the row.
        assignees: [...new Set([...t.assigneeIds, ...(extra.assignees.get(t.id) ?? [])])].slice(0, 20),
      })),
      dependencies: depRows.map((d) => ({ task: d.taskId, dependsOn: d.dependsOnId })),
      timeEntries: entryRows
        .filter((e) => e.endedAt && e.minutes != null)
        .map((e) => ({ task: e.taskId, user: e.userId, source: e.source, startedAt: iso(e.startedAt), endedAt: iso(e.endedAt!), minutes: e.minutes! })),
      blocks: blockRows.map((b) => ({ task: b.taskId, date: b.date, start: b.start, end: b.end, locked: b.locked })),
      activity: activityRows.map((r) => ({
        actor: r.actorId ?? extra.actor.get(r.id) ?? null,
        actorName: r.actorName,
        via: r.via,
        client: r.client,
        action: r.action,
        project: r.projectId,
        task: r.taskId,
        subject: r.subject,
        data: r.data ?? {},
        createdAt: iso(r.createdAt),
      })),
      webhooks: hookRows.map((h) => ({
        id: h.id,
        name: h.name,
        url: h.url,
        format: h.format,
        events: h.events,
        projects: h.projectIds ?? null,
        alertHour: h.alertHour,
        remindMinutes: h.remindMinutes,
        timezone: h.timezone,
        enabled: h.enabled,
        createdBy: h.createdBy ?? extra.hookCreator.get(h.id) ?? null,
        createdAt: iso(h.createdAt),
      })),
      // No secret URL (nor its hash): the target makes a new one and shows it once.
      incomingWebhooks: incomingRows.map((h) => ({
        name: h.name,
        project: h.projectId,
        allowUpdates: h.allowUpdates,
        createdBy: h.createdBy,
        useCount: h.useCount,
        lastUsedAt: isoOrNull(h.lastUsedAt),
        createdAt: iso(h.createdAt),
      })),
      account,
    };
    if (secrets.mode === 'plain') bundle.secrets = { mode: 'plain', data: secretData };
    else if (secrets.mode === 'locked') bundle.secrets = await lockSecrets(secretData, secrets.passphrase, exportId);

    const json = JSON.stringify(bundle);
    if (Buffer.byteLength(json, 'utf8') > MIGRATION_MAX_BYTES) throw tooLarge();
    return { json, bundle, ws };
  }
}
