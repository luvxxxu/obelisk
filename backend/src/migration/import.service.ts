import { BadRequestException, ConflictException, Injectable, NotFoundException, type OnModuleDestroy } from '@nestjs/common';
import {
  jevEndpoint,
  jevPresetOf,
  migrationBundle,
  migrationHeaderIssue,
  migrationImportInput,
  remapActivityData,
  renumberRef,
  type MigrationBundle,
  type MigrationCounts,
  type MigrationPerson,
  type MigrationPreview,
  type MigrationResult,
  type MigrationSecrets,
  type MigrationStageStatus,
} from '@obelisk/core';
import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import { and, count, desc, eq, inArray, max, ne, sql } from 'drizzle-orm';
import { randomToken, sha256 } from '../common/crypto';
import { mailAvailable } from '../common/mail';
import { seal } from '../common/secret';
import { config } from '../config';
import { InjectDb, type Db } from '../db/db.module';
import {
  activity,
  avatars,
  incomingWebhooks,
  memberReservations,
  migrationImports,
  projectMembers,
  projects,
  projectTeams,
  taskDependencies,
  tasks,
  teamMembers,
  teams,
  users,
  webhooks,
  workspaceMembers,
  workspaces,
  type ReservationClaims,
  type UserRow,
  type WorkspaceRole,
} from '../db/schema';
import { jevKeyContext } from '../jev/status';
import { secretContext } from '../webhooks/delivery.service';
import { incomingUrl } from '../webhooks/incoming.service';
import { assertDeliverable } from '../webhooks/net';
import { AccessService, type Conn } from '../workspace/access.service';
import { readAvatar } from '../workspace/avatars.service';
import { emptyClaims } from './reservations.service';
import { unlockSecrets } from './secrets';
import { StagingStore, type Staged } from './staging';

type Person = MigrationBundle['people'][number];

/** Who each person of the bundle becomes here. */
interface PersonPlan {
  person: Person;
  match: MigrationPerson['match'];
  /** Left the organization on the source; named on its rows only. */
  former: boolean;
  /** The importer for 'you'; the same-email account for 'existing' (noted on the reservation, never let in). */
  account: UserRow | null;
}

interface Plan {
  /** Members first, then former members. */
  people: PersonPlan[];
  /** Personal bundles land in the importer's own space. */
  personal: { id: string; existingTasks: number; taskSeq: number; renumber: boolean } | null;
  /** Webhook URLs this server won't send to (by source id). */
  hooksRefused: Set<string>;
  /** The account's Jev address is fine here. */
  jevOk: boolean;
  alreadyImported: { at: Date; workspaceName: string } | null;
}

/** One place in 가입 대기: an email has one, whoever of the bundle had it. */
interface Reservation {
  email: string;
  name: string;
  role: WorkspaceRole;
  claims: ReservationClaims;
  matched: string | null;
  former: boolean;
}

const INSERT_CHUNK = 500;
/** DNS lookups for webhook hosts at preview time: a few at once, a short wait each, only so many hosts. */
const HOST_CHECKS = { concurrency: 4, timeoutMs: 4_000, max: 50 };
const date = (s: string) => new Date(s);
const dateOrNull = (s: string | null) => (s ? new Date(s) : null);

function chunked<T>(list: T[], size = INSERT_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

export function bundleCounts(b: MigrationBundle): MigrationCounts {
  return {
    projects: b.projects.length,
    tasks: b.tasks.length,
    dependencies: b.dependencies.length,
    activity: b.activity.length,
    teams: b.kind === 'org' ? b.teams.length : 0,
    members: b.kind === 'org' ? b.people.length : 1,
    webhooks: b.webhooks.length,
    incomingWebhooks: b.incomingWebhooks.length,
    photos: (b.kind === 'org' && b.workspace.photo ? 1 : 0) + (b.account?.photo ? 1 : 0),
  };
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** Host of a Jev address other than the TypeSafe default (shown next to "Jev 설정"). */
export function jevHostOf(baseUrl: string | null): string | null {
  if (!baseUrl || jevPresetOf(baseUrl) === 'typesafe') return null;
  try {
    return new URL(baseUrl).host || null;
  } catch {
    return null;
  }
}

/** Same rule as saving a Jev base URL in settings (JevService.checkEndpoint), without the live call. */
async function jevAddressOk(baseUrl: string | null): Promise<boolean> {
  if (!baseUrl) return true;
  try {
    const url = jevEndpoint(baseUrl);
    if (jevPresetOf(baseUrl) !== null && url.startsWith('https://')) return true;
    if (!config.jevAllowPrivate && !url.startsWith('https://')) return false;
    await assertDeliverable(url, config.jevAllowPrivate);
    return true;
  } catch {
    return false;
  }
}

/**
 * Which webhook URLs this server refuses to send to. The form of each URL is checked locally; host
 * names are looked up once each, a few at a time with a short wait, and only the first 50 hosts —
 * a host that can't be checked now is not refused (the hooks arrive switched off, and switching one
 * on checks its address again).
 */
async function refusedHooks(hooks: MigrationBundle['webhooks']): Promise<Set<string>> {
  const refused = new Set<string>();
  const byHost = new Map<string, MigrationBundle['webhooks']>();
  for (const h of hooks) {
    try {
      const url = await assertDeliverable(h.url, true); // form only, no lookup
      const list = byHost.get(url.host) ?? [];
      list.push(h);
      byHost.set(url.host, list);
    } catch {
      refused.add(h.id);
    }
  }
  if (config.webhookAllowPrivate) return refused;
  const hosts = [...byHost.entries()].slice(0, HOST_CHECKS.max);
  let next = 0;
  const worker = async () => {
    while (next < hosts.length) {
      const [, list] = hosts[next++]!;
      const verdict = await Promise.race([
        assertDeliverable(list[0]!.url, false).then(
          () => 'ok' as const,
          (e: { retryable?: boolean }) => (e?.retryable ? ('unknown' as const) : ('refused' as const)),
        ),
        new Promise<'unknown'>((r) => setTimeout(() => r('unknown'), HOST_CHECKS.timeoutMs).unref?.()),
      ]);
      if (verdict === 'refused') for (const h of list) refused.add(h.id);
    }
  };
  await Promise.all(Array.from({ length: HOST_CHECKS.concurrency }, worker));
  return refused;
}

/** Postgres unique violations (a hand-edited file the schema didn't catch) read as a bad file, not a crash. */
function uniqueViolation(e: unknown): boolean {
  const code = (e as { code?: string })?.code ?? (e as { cause?: { code?: string } })?.cause?.code;
  return code === '23505';
}

/**
 * Staging, preview and the import itself. The import runs in one transaction: a new organization
 * (the importer owns it) or the importer's own personal space, then people, teams, projects with
 * their sharing, tasks, links, history, webhooks and photos — every row with a new id. Nobody but
 * the importer becomes a member: everyone else waits in 가입 대기 for their claim link.
 */
@Injectable()
export class ImportService implements OnModuleDestroy {
  readonly staging = new StagingStore();

  constructor(
    @InjectDb() private readonly db: Db,
    private readonly access: AccessService,
  ) {}

  onModuleDestroy() {
    this.staging.close();
  }

  // ───────────────────────────── staging + preview

  async stage(user: UserRow, raw: unknown, bytes = 0): Promise<MigrationPreview> {
    if (this.staging.importing(user.id)) throw new ConflictException('가져오는 중이에요. 끝난 뒤 다시 올려 주세요');
    const issue = migrationHeaderIssue(raw);
    if (issue) throw new BadRequestException(issue);
    const parsed = migrationBundle.safeParse(raw);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      const where = first?.path.length ? ` (${first.path.join('.')})` : '';
      const why = first?.code === 'custom' && first.message ? `: ${first.message}` : '';
      throw new BadRequestException(`파일 내용이 올바르지 않아요${why}${where}. Obelisk에서 내보낸 파일을 그대로 올려 주세요`);
    }
    const staged = this.staging.put(user.id, parsed.data, bytes);
    return this.preview(user, staged);
  }

  discard(user: UserRow, stagingId: string) {
    this.staging.drop(user.id, stagingId);
    return { ok: true as const };
  }

  /** What became of a staged bundle (the import's answer once it is done). */
  status(user: UserRow, stagingId: string): MigrationStageStatus {
    const s = this.staging.get(user.id, stagingId);
    if (!s) return { status: 'gone', result: null };
    return { status: s.state, result: s.state === 'done' ? s.result : null };
  }

  private async plan(conn: Conn, user: UserRow, b: MigrationBundle): Promise<Plan> {
    const mine = user.email.toLowerCase();
    const found = new Map<string, UserRow>();
    if (b.kind === 'org') {
      const emails = [...new Set([...b.people, ...b.formerPeople].map((p) => p.email))].filter((e) => e !== mine);
      for (const part of chunked(emails, 1000)) {
        for (const u of await conn.select().from(users).where(inArray(sql`lower(${users.email})`, part))) found.set(u.email.toLowerCase(), u);
      }
    }
    const people: PersonPlan[] = [
      ...b.people.map((person) => ({ person, former: false })),
      ...b.formerPeople.map((p) => ({ person: { ...p, role: 'member' as const }, former: true })),
    ].map(({ person, former }) => {
      if ((!former && person.id === b.exporterId) || person.email === mine) return { person, former, match: 'you' as const, account: user };
      const account = found.get(person.email) ?? null;
      return { person, former, match: account ? ('existing' as const) : ('reserved' as const), account };
    });

    let personal: Plan['personal'] = null;
    if (b.kind === 'personal') {
      const id = await this.access.personalId(user.id, conn);
      const [[n], ws] = await Promise.all([
        conn.select({ n: count() }).from(tasks).where(eq(tasks.workspaceId, id)),
        conn.query.workspaces.findFirst({ where: eq(workspaces.id, id) }),
      ]);
      const existingTasks = n?.n ?? 0;
      const taskSeq = ws?.taskSeq ?? 0;
      personal = { id, existingTasks, taskSeq, renumber: existingTasks > 0 || taskSeq > 0 };
    }

    const [already, hooksRefused, jevOk] = await Promise.all([
      conn
        .select({ at: migrationImports.createdAt, name: workspaces.name })
        .from(migrationImports)
        .innerJoin(workspaces, eq(workspaces.id, migrationImports.workspaceId))
        .where(and(eq(migrationImports.userId, user.id), eq(migrationImports.exportId, b.exportId)))
        .orderBy(desc(migrationImports.createdAt))
        .limit(1),
      refusedHooks(b.webhooks),
      b.account ? jevAddressOk(b.account.jev.baseUrl) : Promise.resolve(true),
    ]);

    return {
      people,
      personal,
      hooksRefused,
      jevOk,
      alreadyImported: already[0] ? { at: already[0].at, workspaceName: already[0].name } : null,
    };
  }

  /** Warnings both the preview and the import show (the import adds what only it can know). */
  private warnings(b: MigrationBundle, plan: Plan, secrets: 'none' | 'locked' | 'included'): string[] {
    const out: string[] = [];
    const isMine = (id: string | null) => !!id && plan.people.some((p) => p.match === 'you' && p.person.id === id);
    for (const h of b.webhooks) {
      if (plan.hooksRefused.has(h.id)) out.push(`웹훅 “${h.name}”의 주소는 이 서버에서 보낼 수 없어요. 주소를 바꾼 뒤 켜 주세요.`);
    }
    if (b.webhooks.length) out.push('보내는 웹훅은 꺼진 채로 들어와요. 주소를 확인한 뒤 켜 주세요.');
    if (secrets === 'none' && b.webhooks.length) out.push('웹훅 서명 키가 담겨 있지 않아 새로 만들어요. 받는 쪽에 새 키를 알려 주세요.');
    if (secrets === 'none' && b.account?.jev.hasKey) out.push('Jev 키가 담겨 있지 않아요. 가져온 뒤 설정 → Jev에서 다시 입력하세요.');
    // New incoming webhook URLs and API tokens that stay behind have fields of their own
    // (preview.account.tokensNotMoved, result.incoming / tokensNotMoved), so the page words them.
    if (b.kind === 'org') {
      for (const h of b.incomingWebhooks) {
        if (!isMine(h.createdBy)) out.push(`받는 웹훅 “${h.name}”은 만든 사람이 아직 이 서버에 없어 내 이름으로 옮겨요.`);
      }
    }
    if (b.account && !plan.jevOk) out.push('Jev 연결 주소를 이 서버에서 쓸 수 없어 Jev 설정은 빼고 가져와요.');
    return out;
  }

  async preview(user: UserRow, staged: Staged): Promise<MigrationPreview> {
    const b = staged.bundle;
    if (!b) throw new NotFoundException('가져올 파일이 만료됐어요. 다시 올려 주세요');
    const plan = await this.plan(this.db, user, b);
    const secrets = !b.secrets ? 'none' : b.secrets.mode === 'locked' ? 'locked' : 'included';
    const jev = b.account?.jev;
    return {
      stagingId: staged.id,
      expiresAt: staged.expiresAt.toISOString(),
      kind: b.kind,
      workspaceName: b.workspace.name,
      source: { url: b.source.url, exportedAt: b.exportedAt },
      counts: bundleCounts(b),
      // Only what the file itself says: no names of accounts here.
      people:
        b.kind === 'org'
          ? plan.people.map((p) => ({ email: p.person.email, name: p.person.name, role: p.person.role, match: p.match, former: p.former }))
          : [],
      secrets,
      target: plan.personal
        ? { kind: 'merge-personal', renumber: plan.personal.renumber, existingTasks: plan.personal.existingTasks }
        : { kind: 'new-org', name: b.workspace.name },
      account:
        b.account && jev
          ? {
              timezone: b.account.timezone,
              photo: !!b.account.photo,
              jev: plan.jevOk && (jev.hasKey || !!jev.baseUrl || !!jev.model || jev.autoApply),
              jevKey: plan.jevOk && (secrets === 'included' ? !!(b.secrets?.mode === 'plain' && b.secrets.data.jevKey) : secrets === 'locked' && jev.hasKey),
              jevHost: jevHostOf(jev.baseUrl),
              homeLayout: !!b.account.homeLayout,
              tokensNotMoved: b.account.apiTokens.map((t) => t.name),
            }
          : null,
      alreadyImported: plan.alreadyImported
        ? { at: plan.alreadyImported.at.toISOString(), workspaceName: plan.alreadyImported.workspaceName }
        : null,
      warnings: this.warnings(b, plan, secrets),
    };
  }

  // ───────────────────────────── import

  async import(user: UserRow, input: z.output<typeof migrationImportInput>): Promise<MigrationResult> {
    const staged = this.staging.begin(user.id, input.stagingId);
    if (staged === 'busy') throw new ConflictException('가져오는 중이에요. 잠시 뒤 결과를 확인하세요');
    // Already imported (a retry after the answer got lost): the same answer again, nothing written twice.
    if (staged === 'done') return this.staging.get(user.id, input.stagingId)!.result!;
    if (!staged?.bundle) throw new NotFoundException('가져올 파일이 만료됐어요. 다시 올려 주세요');
    try {
      const result = await this.run(user, staged.bundle, input);
      this.staging.finish(staged, result);
      return result;
    } catch (e) {
      this.staging.release(staged);
      if (uniqueViolation(e)) throw new BadRequestException('파일 안에 겹치는 내용이 있어 가져오지 못했어요. Obelisk에서 내보낸 파일을 그대로 올려 주세요');
      throw e;
    }
  }

  private async run(user: UserRow, b: MigrationBundle, input: z.output<typeof migrationImportInput>): Promise<MigrationResult> {
    const extra: string[] = [];

    // Secrets first: a wrong passphrase stops here, before anything is written.
    let secrets: MigrationSecrets | null = null;
    if (b.secrets?.mode === 'plain') secrets = b.secrets.data;
    else if (b.secrets?.mode === 'locked') {
      if (input.passphrase) {
        secrets = await unlockSecrets(b.secrets, input.passphrase, b.exportId);
        if (!secrets) throw new BadRequestException('암호가 맞지 않아요');
      } else {
        extra.push('암호를 넣지 않아 Jev 키와 웹훅 서명 키는 빼고 가져왔어요.');
      }
    }

    // Photos are checked before the transaction too (bad bytes just mean no photo).
    const readPhoto = (p: MigrationBundle['workspace']['photo']) => {
      if (!p) return null;
      try {
        const { data, info } = readAvatar(Buffer.from(p.data, 'base64'));
        return { data, contentType: info.type };
      } catch {
        extra.push('사진 하나를 읽을 수 없어 건너뛰었어요.');
        return null;
      }
    };
    const orgPhoto = b.kind === 'org' ? readPhoto(b.workspace.photo) : null;
    const accountPhoto = b.account && input.applySettings ? readPhoto(b.account.photo) : null;

    return this.db.transaction(async (tx) => {
      // One import of a given file per person at a time: a second request waits here, then sees the first.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`migration:${user.id}:${b.exportId}`}))`);
      const dup = await tx
        .select({ id: migrationImports.id })
        .from(migrationImports)
        .where(and(eq(migrationImports.userId, user.id), eq(migrationImports.exportId, b.exportId)))
        .limit(1);
      if (dup.length && !input.allowDuplicate) throw new ConflictException('이미 가져온 파일이에요');

      const plan = await this.plan(tx, user, b);
      const personal = plan.personal;
      const isOrg = b.kind === 'org';

      // ── target workspace
      const sourceMax = b.tasks.reduce((m, t) => Math.max(m, t.number), 0);
      let workspaceId: string;
      let renumber = false;
      let base = 0;
      let projectBase: number | null = null;
      if (personal) {
        workspaceId = personal.id;
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${workspaceId}))`);
        const [locked] = await tx.select().from(workspaces).where(eq(workspaces.id, workspaceId)).for('update');
        const [n] = await tx.select({ n: count() }).from(tasks).where(eq(tasks.workspaceId, workspaceId));
        renumber = (n?.n ?? 0) > 0 || (locked?.taskSeq ?? 0) > 0;
        base = locked?.taskSeq ?? 0;
        // Projects join after the ones already here, in their own order (as creating one does: max + 1).
        const [top] = await tx.select({ p: max(projects.position) }).from(projects).where(eq(projects.workspaceId, workspaceId));
        projectBase = top?.p ?? 0;
      } else {
        workspaceId = randomUUID();
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${workspaceId}))`);
        await tx.insert(workspaces).values({
          id: workspaceId,
          kind: 'org',
          name: b.workspace.name,
          membersCanCreateProjects: b.workspace.membersCanCreateProjects,
          taskSeq: Math.max(sourceMax, b.workspace.taskSeq),
        });
        await tx.insert(workspaceMembers).values({ workspaceId, userId: user.id, role: 'owner' });
      }

      // ── people: the importer is the exporter; everyone else waits in 가입 대기 (one place per email),
      // an account here with the same email included — it gets in only with the claim link.
      const userOf = new Map<string, string>(); // source person → user here
      const reservedOf = new Map<string, Reservation>(); // source person → place
      const placeOf = new Map<string, Reservation>(); // email → place
      for (const p of plan.people) {
        if (p.match === 'you') {
          userOf.set(p.person.id, user.id);
          continue;
        }
        if (!isOrg) continue;
        let r = placeOf.get(p.person.email);
        if (!r) {
          r = {
            email: p.person.email,
            name: p.person.name,
            role: p.former ? 'member' : p.person.role,
            claims: emptyClaims(),
            matched: p.account?.id ?? null,
            former: p.former,
          };
          placeOf.set(p.person.email, r);
        }
        reservedOf.set(p.person.id, r);
      }
      const places = [...placeOf.values()];
      const reservedCount = places.filter((r) => !r.former).length;
      const mapUser = (id: string | null) => (id ? (userOf.get(id) ?? null) : null);
      const claimsOf = (id: string | null) => (id ? (reservedOf.get(id)?.claims ?? null) : null);

      const teamIds = new Map<string, string>();
      const projectIds = new Map<string, string>();
      const taskIds = new Map<string, string>();
      const counts: MigrationCounts = {
        projects: 0,
        tasks: 0,
        dependencies: 0,
        activity: 0,
        teams: 0,
        members: 1 + reservedCount,
        webhooks: 0,
        incomingWebhooks: 0,
        photos: 0,
      };

      // ── teams
      if (isOrg) {
        for (const t of b.teams) {
          const id = randomUUID();
          teamIds.set(t.id, id);
          await tx.insert(teams).values({ id, workspaceId, name: t.name, createdAt: date(t.createdAt) });
          counts.teams++;
          const memberRows = [...new Set(t.members.map((m) => mapUser(m)).filter((u): u is string => !!u))];
          if (memberRows.length) await tx.insert(teamMembers).values(memberRows.map((userId) => ({ teamId: id, userId }))).onConflictDoNothing();
          for (const m of new Set(t.members)) {
            const c = claimsOf(m);
            if (c && !c.teams.includes(id)) c.teams.push(id);
          }
        }
      }

      // ── projects and their sharing
      const orderedProjects = projectBase === null ? b.projects : [...b.projects].sort((x, y) => x.position - y.position);
      orderedProjects.forEach((p) => projectIds.set(p.id, randomUUID()));
      for (const part of chunked(orderedProjects.map((p, i) => ({ p, i })))) {
        await tx.insert(projects).values(
          part.map(({ p, i }) => {
            const id = projectIds.get(p.id)!;
            claimsOf(p.createdBy)?.projectsCreated.push(id);
            return {
              id,
              workspaceId,
              createdBy: mapUser(p.createdBy),
              memberAccess: isOrg ? p.memberAccess : ('none' as const),
              name: p.name,
              color: p.color,
              position: projectBase === null ? p.position : projectBase + i + 1,
              archivedAt: dateOrNull(p.archivedAt),
              createdAt: date(p.createdAt),
              updatedAt: date(p.updatedAt),
            };
          }),
        );
        counts.projects += part.length;
      }
      if (isOrg) {
        const memberGrants: { projectId: string; userId: string; level: 'view' | 'edit' | 'manage' }[] = [];
        const teamGrants: { projectId: string; teamId: string; level: 'view' | 'edit' | 'manage' }[] = [];
        for (const p of b.projects) {
          const projectId = projectIds.get(p.id)!;
          for (const g of p.members) {
            const u = mapUser(g.person);
            if (u) memberGrants.push({ projectId, userId: u, level: g.level });
            else claimsOf(g.person)?.projects.push({ projectId, level: g.level });
          }
          for (const g of p.teams) {
            const teamId = teamIds.get(g.team);
            if (teamId) teamGrants.push({ projectId, teamId, level: g.level });
          }
        }
        for (const part of chunked(memberGrants)) await tx.insert(projectMembers).values(part).onConflictDoNothing();
        for (const part of chunked(teamGrants)) await tx.insert(projectTeams).values(part).onConflictDoNothing();
      }

      // ── tasks
      const ordered = [...b.tasks].sort((x, y) => x.number - y.number);
      ordered.forEach((t) => taskIds.set(t.id, randomUUID()));
      const numberOf = new Map(ordered.map((t, i) => [t.id, renumber ? base + i + 1 : t.number]));
      const oldNumber = new Map(ordered.map((t) => [t.id, t.number]));
      for (const part of chunked(ordered)) {
        await tx.insert(tasks).values(
          part.map((t) => {
            const id = taskIds.get(t.id)!;
            claimsOf(t.assignee)?.assigned.push(id);
            claimsOf(t.createdBy)?.created.push(id);
            return {
              id,
              workspaceId,
              createdBy: mapUser(t.createdBy),
              assigneeId: mapUser(t.assignee),
              number: numberOf.get(t.id)!,
              projectId: t.project ? (projectIds.get(t.project) ?? null) : null,
              title: t.title,
              notes: t.notes,
              status: t.status,
              priority: t.priority,
              startDate: t.startDate,
              dueDate: t.dueDate,
              startTime: t.startTime,
              dueTime: t.dueTime,
              fixed: t.fixed,
              position: t.position,
              postponedCount: t.postponedCount,
              completedAt: dateOrNull(t.completedAt),
              createdAt: date(t.createdAt),
              updatedAt: date(t.updatedAt),
            };
          }),
        );
        counts.tasks += part.length;
      }
      if (personal) {
        const top = renumber ? base + ordered.length : Math.max(base, sourceMax, b.workspace.taskSeq);
        await tx.update(workspaces).set({ taskSeq: top, updatedAt: new Date() }).where(eq(workspaces.id, workspaceId));
      }

      // ── dependencies (the source had no cycles; self-loops and missing ends are dropped)
      const seen = new Set<string>();
      const links: { taskId: string; dependsOnId: string; workspaceId: string }[] = [];
      for (const d of b.dependencies) {
        const taskId = taskIds.get(d.task);
        const dependsOnId = taskIds.get(d.dependsOn);
        if (!taskId || !dependsOnId || taskId === dependsOnId) continue;
        const key = `${taskId}:${dependsOnId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        links.push({ taskId, dependsOnId, workspaceId });
      }
      for (const part of chunked(links)) {
        await tx.insert(taskDependencies).values(part).onConflictDoNothing();
        counts.dependencies += part.length;
      }

      // ── history, straight into the table (recording would send webhooks for every old entry).
      // Ids that only appear in history (deleted rows) get fresh ids in maps of their own, so the
      // maps above keep meaning "a row that was imported".
      const fresh = (known: Map<string, string>) => {
        const gone = new Map<string, string>();
        return (id: string) => {
          const v = known.get(id) ?? gone.get(id);
          if (v) return v;
          const n = randomUUID();
          gone.set(id, n);
          return n;
        };
      };
      const idMap = { task: fresh(taskIds), project: fresh(projectIds), team: fresh(teamIds), user: (id: string) => mapUser(id) };
      // "#12 Title" snapshots follow a renumbered task (only for tasks of this file).
      const renum = (text: unknown, sourceTask: unknown) => {
        if (!renumber || typeof text !== 'string' || typeof sourceTask !== 'string') return text;
        const from = oldNumber.get(sourceTask);
        const to = numberOf.get(sourceTask);
        return from === undefined || to === undefined ? text : renumberRef(text, from, to);
      };
      for (const part of chunked(b.activity, 1000)) {
        await tx.insert(activity).values(
          part.map((e) => {
            const id = randomUUID();
            claimsOf(e.actor)?.activity.push(id);
            let data = e.data;
            if (renumber && (data.cause !== undefined || data.blockedBy !== undefined)) {
              data = { ...data };
              if (data.cause !== undefined) data.cause = renum(data.cause, data.causeId);
              if (data.blockedBy !== undefined) data.blockedBy = renum(data.blockedBy, data.blockedById);
            }
            return {
              id,
              workspaceId,
              actorId: mapUser(e.actor),
              actorName: e.actorName,
              via: e.via,
              client: e.client,
              action: e.action,
              projectId: e.project ? idMap.project(e.project) : null,
              taskId: e.task ? idMap.task(e.task) : null,
              subject: e.task ? (renum(e.subject, e.task) as string) : e.subject,
              data: remapActivityData(e.action, data, idMap),
              createdAt: date(e.createdAt),
            };
          }),
        );
        counts.activity += part.length;
      }

      // ── outgoing webhooks: off until someone checks them, same secret when it came along
      let freshSecrets = 0;
      for (const h of b.webhooks) {
        let projectList: string[] | null = null;
        if (h.projects) {
          projectList = [...new Set(h.projects.map((p) => projectIds.get(p)).filter((p): p is string => !!p))];
          if (!projectList.length) {
            extra.push(`웹훅 “${h.name}”은 보내던 프로젝트가 없어 건너뛰었어요.`);
            continue;
          }
        }
        const id = randomUUID();
        let secret = secrets?.webhooks[h.id];
        if (!secret) {
          secret = randomToken('whsec', 24);
          freshSecrets++;
        }
        claimsOf(h.createdBy)?.webhooks.push(id);
        await tx.insert(webhooks).values({
          id,
          workspaceId,
          createdBy: mapUser(h.createdBy),
          name: h.name,
          url: h.url,
          format: h.format,
          events: h.events,
          projectIds: projectList,
          alertHour: h.alertHour,
          remindMinutes: h.remindMinutes,
          timezone: h.timezone,
          secret: seal(secret, secretContext(id)),
          enabled: false,
          disabledReason: '다른 서버에서 가져왔어요. 확인한 뒤 켜 주세요',
          failureCount: 0,
          createdAt: date(h.createdAt),
        });
        counts.webhooks++;
      }
      if (freshSecrets && secrets) extra.push('일부 웹훅의 서명 키를 열 수 없어 새로 만들었어요. 받는 쪽에 새 키를 알려 주세요.');

      // ── incoming webhooks: a new secret URL each (a file must never decide which URL works here),
      // shown once in the answer.
      const incoming: MigrationResult['incoming'] = [];
      for (const h of b.incomingWebhooks) {
        const token = randomToken('obh', 24);
        await tx.insert(incomingWebhooks).values({
          workspaceId,
          createdBy: mapUser(h.createdBy) ?? user.id,
          name: h.name,
          tokenHash: sha256(token),
          hint: token.slice(-4),
          projectId: h.project ? (projectIds.get(h.project) ?? null) : null,
          allowUpdates: h.allowUpdates,
          useCount: h.useCount,
          lastUsedAt: dateOrNull(h.lastUsedAt),
          createdAt: date(h.createdAt),
        });
        incoming.push({ name: h.name, url: incomingUrl(token) });
        counts.incomingWebhooks++;
      }

      // ── organization photo
      if (orgPhoto) {
        const [row] = await tx.insert(avatars).values({ workspaceId, ...orgPhoto }).returning({ id: avatars.id });
        await tx.update(workspaces).set({ avatarId: row!.id }).where(eq(workspaces.id, workspaceId));
        counts.photos++;
      }

      // ── 가입 대기 for everyone else (same-email accounts noted, never let in)
      for (const part of chunked(places)) {
        await tx
          .insert(memberReservations)
          .values(
            part.map((r) => ({
              workspaceId,
              email: r.email,
              name: r.name,
              role: r.role,
              createdBy: user.id,
              claims: r.former ? { ...r.claims, former: true } : r.claims,
              matchedUserId: r.matched,
            })),
          )
          .onConflictDoNothing();
      }

      // ── the importer's own settings (personal bundles). API tokens are never moved.
      if (b.account && input.applySettings) {
        const acc = b.account;
        const patch: Partial<UserRow> = { timezone: acc.timezone, homeLayout: acc.homeLayout ?? null };
        if (plan.jevOk) {
          const key = acc.jev.hasKey ? (secrets?.jevKey ?? null) : null;
          patch.jevAutoApply = acc.jev.autoApply;
          if (key) {
            Object.assign(patch, {
              jevKey: seal(key, jevKeyContext(user.id)),
              jevKeyHint: key.slice(-4),
              jevBaseUrl: acc.jev.baseUrl,
              jevModel: acc.jev.model,
            });
          } else if (!user.jevKey) {
            // Without the key only the service moves, and only when no key here would follow it elsewhere.
            Object.assign(patch, { jevBaseUrl: acc.jev.baseUrl, jevModel: acc.jev.model });
          }
        }
        await tx.update(users).set(patch).where(eq(users.id, user.id));
        if (accountPhoto) {
          await tx.select({ id: users.id }).from(users).where(eq(users.id, user.id)).for('update');
          const [row] = await tx.insert(avatars).values({ userId: user.id, ...accountPhoto }).returning({ id: avatars.id });
          await tx.update(users).set({ avatarId: row!.id }).where(eq(users.id, user.id));
          await tx.delete(avatars).where(and(eq(avatars.userId, user.id), ne(avatars.id, row!.id)));
          counts.photos++;
        }
      }

      const secretsKind = !b.secrets ? 'none' : b.secrets.mode === 'locked' ? 'locked' : 'included';
      const warnings = [...this.warnings(b, plan, secrets ? secretsKind : 'none'), ...extra].filter((w, i, all) => all.indexOf(w) === i);
      // The "no secrets" lines say it already when the passphrase was left out.
      const finalWarnings =
        b.secrets?.mode === 'locked' && !secrets ? warnings.filter((w) => !w.includes('담겨 있지 않')) : warnings;

      // ── one line in the log, and a note so the same file isn't imported twice by accident
      const summary = { ...counts, reserved: reservedCount, renumbered: renumber };
      await tx.insert(activity).values({
        workspaceId,
        actorId: user.id,
        actorName: user.name,
        via: 'system',
        client: null,
        action: 'workspace.imported',
        subject: b.workspace.name,
        data: { from: b.source.url, exportedAt: b.exportedAt, counts },
      });
      await tx.insert(migrationImports).values({
        exportId: b.exportId,
        userId: user.id,
        workspaceId,
        sourceUrl: b.source.url,
        kind: b.kind,
        summary,
      });

      const name = personal ? ((await tx.query.workspaces.findFirst({ where: eq(workspaces.id, workspaceId) }))?.name ?? b.workspace.name) : b.workspace.name;
      console.log(
        `[migration] ${user.email} imported ${b.kind} "${b.workspace.name}" from ${hostOf(b.source.url)}: ` +
          `${counts.tasks} tasks, ${counts.projects} projects, ${reservedCount} reserved`,
      );
      return {
        workspaceId,
        kind: b.kind,
        workspaceName: name,
        counts,
        reserved: reservedCount,
        mailEnabled: isOrg && mailAvailable(),
        renumbered: renumber,
        tokensNotMoved: b.account?.apiTokens.map((t) => t.name) ?? [],
        incoming,
        warnings: finalWarnings,
      } satisfies MigrationResult;
    });
  }
}
