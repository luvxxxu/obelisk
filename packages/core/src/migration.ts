/**
 * Moving a personal space or an organization from one Obelisk server to another.
 *
 * The source server writes a bundle (a JSON file, or the answer to a one-time 이전 링크); the target
 * validates it with `migrationBundle`, shows a preview, and imports it in one transaction. Every id in
 * a bundle is the source's and only ties rows of the same bundle together: the target makes new ids.
 */
import { z } from 'zod';
import { isValidTimeZone } from './dates';
import { homeLayoutInput, isoDate, isoTime } from './schemas';
import { PROJECT_COLORS, type WorkspaceRole } from './types';
import { WEBHOOK_EVENT_KEYS, WEBHOOK_FORMATS } from './webhooks';

export const MIGRATION_FORMAT = 'obelisk-export';
export const MIGRATION_VERSION = 1;
/** Largest bundle a server writes or reads (after gunzip). */
export const MIGRATION_MAX_BYTES = 64 * 1024 * 1024;
/** Content type the web app uploads a bundle file with. */
export const MIGRATION_UPLOAD_TYPE = 'application/x-obelisk-export';

export type MigrationKind = 'personal' | 'org';

export interface MigrationCounts {
  projects: number;
  tasks: number;
  dependencies: number;
  activity: number;
  teams: number;
  /** People of the organization (you plus everyone waiting in 가입 대기); 1 for a personal space. */
  members: number;
  webhooks: number;
  incomingWebhooks: number;
  photos: number;
}

export interface MigrationPerson {
  email: string;
  name: string;
  role: WorkspaceRole;
  /**
   * you = the importer; existing = an account here has the same email (it still joins only through
   * the claim link); reserved = nobody here yet. Everyone but you waits in 가입 대기.
   */
  match: 'you' | 'existing' | 'reserved';
  /** Left the organization on the source but still authored rows there: kept for the record only. */
  former: boolean;
}

export interface MigrationPreview {
  stagingId: string;
  expiresAt: string;
  kind: MigrationKind;
  workspaceName: string;
  source: { url: string; exportedAt: string };
  counts: MigrationCounts;
  people: MigrationPerson[];
  secrets: 'none' | 'locked' | 'included';
  target: { kind: 'merge-personal'; renumber: boolean; existingTasks: number } | { kind: 'new-org'; name: string };
  account: null | {
    timezone: string;
    photo: boolean;
    jev: boolean;
    jevKey: boolean;
    /** Host of a custom Jev address; null for the TypeSafe default. */
    jevHost: string | null;
    homeLayout: boolean;
    /** API tokens on the source. They are not moved: make new ones here (AI 연결). */
    tokensNotMoved: string[];
  };
  alreadyImported: { at: string; workspaceName: string } | null;
  /** Korean, one sentence each. */
  warnings: string[];
}

export const migrationImportInput = z.object({
  stagingId: z.uuid(),
  passphrase: z.string().max(200).optional().nullable(),
  applySettings: z.boolean().default(true),
  allowDuplicate: z.boolean().default(false),
});
export type MigrationImportInput = z.input<typeof migrationImportInput>;

export interface MigrationResult {
  workspaceId: string;
  kind: MigrationKind;
  workspaceName: string;
  counts: MigrationCounts;
  /** People waiting in 가입 대기 (organizations; former members not counted). */
  reserved: number;
  /** This server can mail claim links (POST /api/workspaces/:id/reservations/mail-all). */
  mailEnabled: boolean;
  renumbered: boolean;
  /** Names of the source's API tokens, which were not moved. */
  tokensNotMoved: string[];
  /** Incoming webhooks recreated with new secret URLs, shown only in this answer. */
  incoming: { name: string; url: string }[];
  warnings: string[];
}

/** GET /api/migration/stage/:stagingId — lets the page find out what happened to an import whose answer got lost. */
export interface MigrationStageStatus {
  status: 'waiting' | 'importing' | 'done' | 'gone';
  /** The import's answer while status is 'done'. */
  result: MigrationResult | null;
}

export interface MigrationCode {
  link: string;
  expiresAt: string;
}

/** Someone from an imported organization who hasn't joined here yet (조직 설정 → 멤버 → 가입 대기). */
export interface MemberReservation {
  id: string;
  email: string;
  name: string;
  role: WorkspaceRole;
  /**
   * signed_up = an account here has this email. That alone never lets it in: the person joins
   * through the claim link like everyone else.
   */
  status: 'waiting' | 'signed_up';
  /** Had left the organization on the source; kept so their old work can be handed back. */
  former: boolean;
  /** A claim link has been made (it is shown only once, so making another retires it). */
  hasLink: boolean;
  createdAt: string;
}

export const migrationExportInput = z.object({
  workspaceId: z.uuid(),
  passphrase: z.string().min(8, '암호는 8자 이상이어야 해요').max(200).optional().nullable(),
});
export const migrationCodeInput = z.object({ workspaceId: z.uuid() });
export const migrationStageRemoteInput = z.object({ link: z.string().trim().min(8).max(2000) });

// ───────────────────────────── 이전 링크

const CODE_RE = /^omg_[A-Za-z0-9_-]{16,128}$/;

/**
 * `https://a.example/settings/migrate#omg_…` → the source server's origin and the one-time code.
 * null for anything else, a bare code included (the target needs to know which server to ask).
 */
export function parseMigrationLink(link: string): { origin: string; code: string } | null {
  const s = link.trim();
  if (!/^https?:\/\//i.test(s)) return null;
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    return null;
  }
  if (url.username || url.password) return null;
  const code = decodeURIComponent(url.hash.replace(/^#/, '')).trim();
  if (!CODE_RE.test(code)) return null;
  return { origin: url.origin, code };
}

// ───────────────────────────── bundle

/** Source ids: UUIDs, used only as references inside the bundle. */
const ref = z.guid();
const when = z.iso.datetime({ offset: true });
const role = z.enum(['owner', 'admin', 'member']);
const level = z.enum(['view', 'edit', 'manage']);
const name = (max: number) => z.string().trim().min(1).max(max);
/** A zone this server doesn't know falls back to Seoul rather than failing the whole import. */
const zone = z
  .string()
  .max(100)
  .transform((tz) => (isValidTimeZone(tz) ? tz : 'Asia/Seoul'));

export const migrationPhoto = z.object({
  contentType: z.enum(['image/webp', 'image/png', 'image/jpeg']),
  /** base64 of the image bytes (at most 512 KB, checked again on import). */
  data: z.string().max(1_000_000).regex(/^[A-Za-z0-9+/=]*$/),
});
export type MigrationPhoto = z.infer<typeof migrationPhoto>;

/** The plaintext secrets: the exporter's Jev key and each outgoing webhook's signing secret by source id. */
export const migrationSecretsData = z.object({
  jevKey: z.string().min(1).max(512).nullable(),
  webhooks: z.record(z.string(), z.string().min(8).max(200)),
});
export type MigrationSecrets = z.infer<typeof migrationSecretsData>;

const b64url = (max: number) => z.string().min(1).max(max).regex(/^[A-Za-z0-9_-]+$/);

/** Secrets sealed with a passphrase: scrypt → AES-256-GCM, AAD "obelisk-export:<exportId>". */
export const migrationLockedSecrets = z.object({
  mode: z.literal('locked'),
  kdf: z.literal('scrypt'),
  N: z
    .number()
    .int()
    .min(2 ** 14)
    .max(2 ** 16)
    .refine((n) => (n & (n - 1)) === 0, 'N must be a power of two'),
  r: z.number().int().min(1).max(8),
  p: z.number().int().min(1).max(2),
  salt: b64url(64),
  iv: b64url(32),
  tag: b64url(32),
  body: b64url(400_000),
});
export type MigrationLockedSecrets = z.infer<typeof migrationLockedSecrets>;

const task = z
  .object({
    id: ref,
    number: z.number().int().min(1).max(100_000_000),
    project: ref.nullable(),
    title: z.string().min(1).max(500),
    notes: z.string().max(20_000),
    status: z.enum(['todo', 'doing', 'done', 'canceled']),
    priority: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]),
    startDate: isoDate.nullable(),
    dueDate: isoDate.nullable(),
    startTime: isoTime.nullable(),
    dueTime: isoTime.nullable(),
    fixed: z.boolean(),
    position: z.number().finite(),
    postponedCount: z.number().int().min(0).max(1_000_000),
    completedAt: when.nullable(),
    createdAt: when,
    updatedAt: when,
    createdBy: ref.nullable(),
    assignee: ref.nullable(),
  })
  // A time only exists with its date (the database insists).
  .transform((t) => ({ ...t, startTime: t.startDate ? t.startTime : null, dueTime: t.dueDate ? t.dueTime : null }));

export const migrationBundle = z
  .object({
    format: z.literal(MIGRATION_FORMAT, 'Obelisk 내보내기 파일이 아니에요'),
    version: z.literal(MIGRATION_VERSION),
    exportId: ref,
    exportedAt: when,
    source: z.object({ url: z.string().min(1).max(500) }),
    kind: z.enum(['personal', 'org']),
    exporterId: ref,
    workspace: z.object({
      id: ref,
      name: name(80),
      taskSeq: z.number().int().min(0).max(100_000_000),
      membersCanCreateProjects: z.boolean(),
      createdAt: when,
      photo: migrationPhoto.nullable(),
    }),
    people: z
      .array(
        z.object({
          id: ref,
          email: z.email().max(320).transform((s) => s.toLowerCase()),
          name: name(80),
          role,
        }),
      )
      .min(1)
      .max(10_000),
    /**
     * People who left the organization but are still named as author or actor of its rows. They come
     * along for the record only: on the target they wait in 가입 대기 as former members.
     */
    formerPeople: z
      .array(
        z.object({
          id: ref,
          email: z.email().max(320).transform((s) => s.toLowerCase()),
          name: name(80),
        }),
      )
      .max(10_000)
      .default([]),
    teams: z
      .array(z.object({ id: ref, name: name(60), createdAt: when, members: z.array(ref).max(10_000) }))
      .max(2_000),
    projects: z
      .array(
        z.object({
          id: ref,
          name: name(120),
          color: z
            .string()
            .max(40)
            .transform((c) => ((PROJECT_COLORS as readonly string[]).includes(c) ? c : 'blue')),
          position: z.number().finite(),
          memberAccess: z.enum(['none', 'view', 'edit']),
          archivedAt: when.nullable(),
          createdBy: ref.nullable(),
          createdAt: when,
          updatedAt: when,
          members: z.array(z.object({ person: ref, level })).max(10_000),
          teams: z.array(z.object({ team: ref, level })).max(2_000),
        }),
      )
      .max(20_000),
    tasks: z.array(task).max(500_000),
    dependencies: z.array(z.object({ task: ref, dependsOn: ref })).max(1_000_000),
    activity: z
      .array(
        z.object({
          actor: ref.nullable(),
          actorName: z.string().max(200),
          via: z.enum(['session', 'api_token', 'oauth', 'webhook', 'system']),
          client: z.string().max(200).nullable(),
          action: z.string().min(1).max(64),
          project: ref.nullable(),
          task: ref.nullable(),
          subject: z.string().max(2_000),
          data: z.record(z.string(), z.unknown()),
          createdAt: when,
        }),
      )
      .max(2_000_000),
    webhooks: z
      .array(
        z.object({
          id: ref,
          name: name(80),
          url: z.string().min(1).max(2_000),
          format: z.enum(WEBHOOK_FORMATS),
          // Event keys this server doesn't know (a newer source) are dropped.
          events: z
            .array(z.string().max(64))
            .max(100)
            .transform((list) => [...new Set(list.filter((k) => (WEBHOOK_EVENT_KEYS as readonly string[]).includes(k)))]),
          projects: z.array(ref).max(500).nullable(),
          alertHour: z.number().int().min(0).max(23),
          remindMinutes: z.number().int().min(0).max(1440),
          timezone: zone,
          enabled: z.boolean(),
          createdBy: ref.nullable(),
          createdAt: when,
        }),
      )
      .max(1_000),
    incomingWebhooks: z
      .array(
        z.object({
          name: name(80),
          // Older files carried the secret URL's hash. It is never used: the target makes a new URL.
          tokenHash: z.string().max(64).optional(),
          hint: z.string().max(16).optional(),
          project: ref.nullable(),
          allowUpdates: z.boolean(),
          createdBy: ref.nullable(),
          useCount: z.number().int().min(0),
          lastUsedAt: when.nullable(),
          createdAt: when,
        }),
      )
      .max(1_000),
    account: z
      .object({
        timezone: zone,
        // A layout this server can't read resets to the default instead of failing the import.
        homeLayout: homeLayoutInput.nullable().catch(null),
        photo: migrationPhoto.nullable(),
        wasDefault: z.boolean(),
        jev: z.object({
          baseUrl: z.string().max(500).nullable(),
          model: z.string().max(200).nullable(),
          autoApply: z.boolean(),
          keyHint: z.string().max(16).nullable(),
          hasKey: z.boolean(),
        }),
        apiTokens: z
          .array(
            // Listed by name only: tokens are never moved (older files also carried a hash, ignored).
            z.object({
              name: name(80),
              prefix: z.string().max(40).optional(),
              tokenHash: z.string().max(64).optional(),
              createdAt: when,
              lastUsedAt: when.nullable(),
            }),
          )
          .max(500),
      })
      .nullable(),
    secrets: z
      .discriminatedUnion('mode', [z.object({ mode: z.literal('plain'), data: migrationSecretsData }), migrationLockedSecrets])
      .optional(),
  })
  .superRefine((b, ctx) => {
    if (!b.people.some((p) => p.id === b.exporterId)) {
      ctx.addIssue({ code: 'custom', message: '내보낸 사람이 명단에 없어요', path: ['people'] });
    }
    // A real export can't repeat these (the source database forbids it); a hand-edited file can.
    const unique = (key: string, values: unknown[], message: string) => {
      const seen = new Set<unknown>();
      values.forEach((v, i) => {
        if (seen.has(v)) ctx.addIssue({ code: 'custom', message, path: [key, i] });
        seen.add(v);
      });
    };
    unique('people', [...b.people.map((p) => p.id), ...b.formerPeople.map((p) => p.id)], '같은 사람이 두 번 들어 있어요');
    unique('people', b.people.map((p) => p.email), '같은 이메일이 두 번 들어 있어요');
    unique('teams', b.teams.map((t) => t.id), '같은 팀이 두 번 들어 있어요');
    unique('teams', b.teams.map((t) => t.name), '같은 이름의 팀이 두 번 들어 있어요');
    unique('projects', b.projects.map((p) => p.id), '같은 프로젝트가 두 번 들어 있어요');
    unique('tasks', b.tasks.map((t) => t.id), '같은 작업이 두 번 들어 있어요');
    unique('tasks', b.tasks.map((t) => t.number), '같은 번호의 작업이 두 번 들어 있어요');
    unique('webhooks', b.webhooks.map((h) => h.id), '같은 웹훅이 두 번 들어 있어요');
  });
export type MigrationBundle = z.infer<typeof migrationBundle>;
/** What a source server writes (before the target's defaults and clean-ups). */
export type MigrationBundleInput = z.input<typeof migrationBundle>;

/**
 * The two header checks, in words people understand, before the full schema runs.
 * null = it looks like a bundle this version can read.
 */
export function migrationHeaderIssue(raw: unknown): string | null {
  const r = raw as { format?: unknown; version?: unknown } | null;
  if (!r || typeof r !== 'object' || r.format !== MIGRATION_FORMAT) return 'Obelisk 내보내기 파일이 아니에요';
  if (typeof r.version !== 'number' || !Number.isInteger(r.version) || r.version < 1) return 'Obelisk 내보내기 파일이 아니에요';
  if (r.version > MIGRATION_VERSION) return '이 파일은 더 새 버전의 Obelisk에서 만들었어요. 이 서버를 먼저 업데이트하세요';
  return null;
}

// ───────────────────────────── activity ids

export interface ActivityIdMap {
  task(id: string): string;
  /** null = the person has no account here (yet). */
  user(id: string): string | null;
  team(id: string): string;
  project(id: string): string;
}

/**
 * Ids inside an activity entry's `data` that point at tasks, people or teams, rewritten for the
 * target: `causeId`, `blockedById`, `assignee.fromId/toId`, `userId`, `teamId`, and the
 * `userId`/`teamId` of each change in `project.access`. Anything else passes through untouched.
 */
export function remapActivityData(action: string, data: Record<string, unknown>, map: ActivityIdMap): Record<string, unknown> {
  const out: Record<string, unknown> = { ...data };
  const str = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
  if (str(out.causeId)) out.causeId = map.task(out.causeId);
  if (str(out.blockedById)) out.blockedById = map.task(out.blockedById);
  if (str(out.userId)) out.userId = map.user(out.userId);
  if (str(out.teamId)) out.teamId = map.team(out.teamId);
  const changes = out.changes;
  if (action === 'project.access' && Array.isArray(changes)) {
    out.changes = changes.map((c) => {
      if (!c || typeof c !== 'object') return c;
      const next = { ...(c as Record<string, unknown>) };
      if (str(next.userId)) next.userId = map.user(next.userId);
      if (str(next.teamId)) next.teamId = map.team(next.teamId);
      return next;
    });
  } else if (changes && typeof changes === 'object' && !Array.isArray(changes)) {
    const assignee = (changes as Record<string, unknown>).assignee;
    if (assignee && typeof assignee === 'object') {
      const a = { ...(assignee as Record<string, unknown>) };
      if (str(a.fromId)) a.fromId = map.user(a.fromId);
      if (str(a.toId)) a.toId = map.user(a.toId);
      out.changes = { ...(changes as Record<string, unknown>), assignee: a };
    }
  }
  return out;
}

/**
 * "#12 Title" → "#40 Title" when a task numbered 12 on the source is #40 here. Only a leading
 * "#<from>" followed by a space (or nothing) changes; anything else is returned as it was.
 */
export function renumberRef(text: string, from: number, to: number): string {
  if (from === to) return text;
  const head = `#${from}`;
  if (text === head) return `#${to}`;
  return text.startsWith(`${head} `) ? `#${to}${text.slice(head.length)}` : text;
}
