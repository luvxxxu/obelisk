import { z } from 'zod';

// ───────────────────────────── server-wide settings (서버 관리)

/**
 * Who may create an account here.
 * open: anyone · approval: anyone may apply, an operator lets them in · invite: only with an invite link
 * (organization invite, claim link or server invite) · closed: no new accounts at all.
 * The very first account can always sign up: it becomes the server's first operator.
 */
export const SIGNUP_MODES = ['open', 'approval', 'invite', 'closed'] as const;
export type SignupMode = (typeof SIGNUP_MODES)[number];

export const SIGNUP_MODE_LABEL_KO: Record<SignupMode, string> = {
  open: '열림',
  approval: '승인제',
  invite: '초대만',
  closed: '닫힘',
};

export const ORG_CREATION = ['everyone', 'admins'] as const;
export type OrgCreation = (typeof ORG_CREATION)[number];

/** Why a signed-in account can't use the app yet. Suspended accounts can't sign in at all. */
export type AccountGate = 'email_unverified' | 'pending_approval';

/** GET /api/auth/signup-status: can someone sign up here, and what follows. */
export interface SignupStatus {
  allowed: boolean;
  /** No account exists yet: this one becomes the server's operator. */
  first: boolean;
  mode: SignupMode;
  /** The invite in the query works (and skips approval and the domain list). */
  invited: boolean;
  /** Without an invite, an operator approves the account before it can be used. */
  approval: boolean;
  /** The new account confirms its address by mail first. */
  verifyEmail: boolean;
  /** Sign-ups without an invite must use one of these domains. */
  domains: string[];
}

export interface Announcement {
  text: string;
  /** When it was last changed: a dismissed banner comes back when this moves. */
  at: string;
}

/** What every signed-in client needs to know about the server (in the bootstrap). */
export interface ServerInfo {
  announcement: Announcement | null;
  /** Organizations can be created by anyone, or only by operators. */
  canCreateOrg: boolean;
}

export interface ServerSettings {
  signupMode: SignupMode;
  /** The mode SIGNUP_MODE gives, used until an operator picks one here. */
  envSignupMode: SignupMode;
  /** True while no mode was picked here (the environment's mode applies). */
  signupModeFromEnv: boolean;
  /** New accounts confirm their address by mail before they can use the app. Needs mail. */
  requireEmailVerification: boolean;
  /** Sign-ups without an invite must use one of these domains (and confirm the address). Empty = any. */
  allowedEmailDomains: string[];
  orgCreation: OrgCreation;
  /** Compare this build with the public repository on GitHub. */
  updateCheck: boolean;
  announcement: Announcement | null;
  /** The server can send mail (SMTP_URL, or a development server printing to the log). */
  mailAvailable: boolean;
  /** Mail goes to the log instead of a mailbox (development without SMTP_URL). */
  mailToLog: boolean;
}

export type AdminAccountState = 'active' | 'suspended' | 'pending' | 'unverified';

export const ADMIN_STATE_LABEL_KO: Record<AdminAccountState, string> = {
  active: '사용 중',
  suspended: '정지됨',
  pending: '승인 대기',
  unverified: '메일 확인 전',
};

/** One account as an operator sees it: who, when, how many. Never what they wrote. */
export interface AdminUser {
  id: string;
  email: string;
  name: string;
  avatarUrl: string | null;
  admin: boolean;
  state: AdminAccountState;
  emailVerified: boolean;
  createdAt: string;
  lastSeenAt: string | null;
  suspendedAt: string | null;
  pendingSince: string | null;
  /** Organizations they belong to, and how many of those they own. */
  orgs: number;
  ownedOrgs: number;
  apiTokens: number;
  aiConnections: number;
}

export const ADMIN_USER_FILTERS = ['all', 'pending', 'suspended', 'admins', 'unverified'] as const;
export type AdminUserFilter = (typeof ADMIN_USER_FILTERS)[number];

export interface AdminUserList {
  users: AdminUser[];
  /** Matches for the current search and filter. */
  total: number;
  counts: Record<AdminUserFilter, number>;
}

export interface AdminOrgOwner {
  id: string;
  name: string;
  email: string;
  suspended: boolean;
}

export interface AdminOrg {
  id: string;
  name: string;
  avatarUrl: string | null;
  createdAt: string;
  members: number;
  owners: AdminOrgOwner[];
  /** No owner who can still sign in: an operator can name one of the members. */
  ownerless: boolean;
  projects: number;
  tasks: number;
}

export interface AdminOrgList {
  orgs: AdminOrg[];
  total: number;
  ownerless: number;
}

export interface AdminOrgMember {
  id: string;
  name: string;
  email: string;
  role: 'owner' | 'admin' | 'member';
  suspended: boolean;
}

export interface ServerInvite {
  id: string;
  /** Last characters of the link, to tell links apart. */
  hint: string;
  note: string;
  maxUses: number | null;
  uses: number;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  createdBy: string | null;
  valid: boolean;
}

export interface AdminLogEntry {
  id: string;
  actorId: string | null;
  actorName: string;
  action: string;
  targetId: string | null;
  targetLabel: string;
  data: Record<string, unknown>;
  createdAt: string;
}

export type CheckState = 'ok' | 'warn' | 'error' | 'info';

export interface ServerCheck {
  id: string;
  label: string;
  state: CheckState;
  /** What is set, never a secret's value. */
  value: string;
  hint?: string;
}

export interface UpdateStatus {
  enabled: boolean;
  /** off: turned off · current: same as the repository · behind: newer commits exist · unknown: this build's commit is not on GitHub · error: GitHub didn't answer */
  state: 'off' | 'current' | 'behind' | 'unknown' | 'error';
  repo: string;
  branch: string;
  checkedAt: string | null;
  behindBy: number | null;
  latest: { commit: string; date: string | null; message: string } | null;
  /** Newest first, at most a handful. */
  commits: { commit: string; date: string | null; message: string }[];
  url: string | null;
  error?: string;
}

export interface BackupStatus {
  /** ok · stale: the newest is over a day old · missing: the folder is empty · unavailable: the folder isn't mounted here */
  state: 'ok' | 'stale' | 'missing' | 'unavailable';
  dir: string;
  count: number;
  totalBytes: number;
  latest: { name: string; at: string; bytes: number } | null;
  keepDays: number | null;
}

export interface ServerUsage {
  users: number;
  activeWeek: number;
  activeMonth: number;
  pending: number;
  suspended: number;
  admins: number;
  orgs: number;
  projects: number;
  tasks: number;
  openTasks: number;
  dbBytes: number;
  photos: number;
  photoBytes: number;
  webhooks: number;
  failingWebhooks: number;
  disabledWebhooks: number;
  apiTokens: number;
  aiConnections: number;
}

export interface ServerStatus {
  version: { commit: string | null; builtAt: string | null };
  update: UpdateStatus;
  checks: ServerCheck[];
  usage: ServerUsage;
  backup: BackupStatus;
  mail: { available: boolean; toLog: boolean; from: string; host: string | null };
}

export interface AdminMailJob {
  id: string;
  subject: string;
  audience: 'all' | 'verified';
  total: number;
  sent: number;
  failed: number;
  done: boolean;
  startedAt: string;
  finishedAt: string | null;
  startedBy: string;
}

// ───────────────────────────── inputs

/** "@Example.com " → "example.com"; anything that isn't a plain domain is refused. */
export const emailDomain = z
  .string()
  .trim()
  .toLowerCase()
  .transform((s) => s.replace(/^@+/, ''))
  .refine((s) => /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(s), {
    message: '도메인은 company.com처럼 적어 주세요',
  });

export const updateServerSettingsInput = z
  .object({
    signupMode: z.enum(SIGNUP_MODES),
    requireEmailVerification: z.boolean(),
    allowedEmailDomains: z.array(emailDomain).max(50, '도메인은 50개까지 정할 수 있어요'),
    orgCreation: z.enum(ORG_CREATION),
    updateCheck: z.boolean(),
  })
  .partial();
export type UpdateServerSettingsInput = z.infer<typeof updateServerSettingsInput>;

export const announcementInput = z.object({
  /** Empty clears the banner. */
  text: z.string().trim().max(300, '공지는 300자까지 쓸 수 있어요'),
});

export const adminUserQuery = z.object({
  q: z.string().trim().max(200).optional(),
  filter: z.enum(ADMIN_USER_FILTERS).optional(),
  offset: z.coerce.number().int().min(0).max(1_000_000).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

export const adminOrgQuery = z.object({
  q: z.string().trim().max(200).optional(),
  ownerless: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
  offset: z.coerce.number().int().min(0).max(1_000_000).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

export const adminLogQuery = z.object({
  offset: z.coerce.number().int().min(0).max(1_000_000).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

export const suspendUserInput = z.object({
  note: z.string().trim().max(200).optional(),
});

/** Destructive operator actions are confirmed by typing the account's email. */
export const confirmEmailInput = z.object({
  confirm: z.string().trim().toLowerCase().min(1).max(320),
});

export const setAdminInput = z.object({ admin: z.boolean() });

export const resetLinkInput = z.object({ mail: z.boolean().optional() });

export const recoverOrgInput = z.object({ userId: z.uuid() });

export const createServerInviteInput = z.object({
  note: z.string().trim().max(80).optional(),
  maxUses: z.number().int().min(1).max(1000).nullable().optional(),
  expiresInDays: z.number().int().min(1).max(365).nullable().optional(),
});
export type CreateServerInviteInput = z.infer<typeof createServerInviteInput>;

export const adminMailInput = z.object({
  subject: z.string().trim().min(1, '제목을 적어 주세요').max(120),
  body: z.string().trim().min(1, '내용을 적어 주세요').max(5000),
  audience: z.enum(['all', 'verified']),
});

export const claimAdminInput = z.object({ token: z.string().trim().min(8).max(200) });

export const emailTokenInput = z.object({ token: z.string().trim().min(8).max(200) });

export const changeEmailInput = z.object({
  email: z.email('올바른 이메일을 입력하세요').transform((s) => s.toLowerCase()),
  password: z.string().min(1).max(200),
});

/** "Is this address allowed to sign up without an invite?" */
export function emailDomainAllowed(email: string, domains: string[]): boolean {
  if (!domains.length) return true;
  const at = email.lastIndexOf('@');
  const domain = at < 0 ? '' : email.slice(at + 1).toLowerCase();
  return domains.includes(domain);
}

/** Operator log line in Korean, e.g. "정지했어요 · 스팸". */
export function describeAdminAction(e: Pick<AdminLogEntry, 'action' | 'data'>): string {
  const d = e.data ?? {};
  switch (e.action) {
    case 'admin.claimed':
      return '서버 로그의 링크로 운영자가 됐어요';
    case 'admin.first':
      return '서버의 첫 계정이라 운영자가 됐어요';
    case 'admin.granted':
      return '운영자로 지정했어요';
    case 'admin.revoked':
      return '운영자에서 해제했어요';
    case 'user.approved':
      return '가입을 승인했어요';
    case 'user.rejected':
      return '가입 신청을 거절했어요';
    case 'user.suspended':
      return d.note ? `정지했어요 · ${String(d.note)}` : '정지했어요';
    case 'user.unsuspended':
      return '정지를 풀었어요';
    case 'user.deleted':
      return '계정을 삭제했어요';
    case 'user.reset_link':
      return d.mailed ? '비밀번호 재설정 링크를 메일로 보냈어요' : '비밀번호 재설정 링크를 만들었어요';
    case 'user.verification_skipped':
      return '메일 확인 없이 쓰도록 허용했어요';
    case 'org.owner_set':
      return `소유자로 지정했어요 · ${String(d.userName ?? '')}`;
    case 'settings.updated': {
      const c = (d.changes ?? {}) as Record<string, { from: unknown; to: unknown }>;
      const parts = Object.entries(c).map(([k, v]) => `${SETTING_LABEL_KO[k] ?? k} ${settingValue(k, v.from)} → ${settingValue(k, v.to)}`);
      return parts.length ? `설정 · ${parts.join(' · ')}` : '설정을 바꿨어요';
    }
    case 'announcement.set':
      return '공지를 올렸어요';
    case 'announcement.cleared':
      return '공지를 내렸어요';
    case 'invite.created':
      return '서버 초대 링크를 만들었어요';
    case 'invite.revoked':
      return '서버 초대 링크를 취소했어요';
    case 'mail.sent':
      return `전체 메일을 보냈어요 · ${String(d.subject ?? '')} · ${Number(d.sent ?? 0)}명${Number(d.failed ?? 0) ? `, 실패 ${Number(d.failed)}` : ''}`;
    default:
      return e.action;
  }
}

const SETTING_LABEL_KO: Record<string, string> = {
  signupMode: '가입',
  requireEmailVerification: '메일 확인',
  allowedEmailDomains: '도메인',
  orgCreation: '조직 만들기',
  updateCheck: '업데이트 확인',
};

function settingValue(key: string, v: unknown): string {
  if (key === 'signupMode') return v ? SIGNUP_MODE_LABEL_KO[v as SignupMode] ?? String(v) : '환경 변수';
  if (key === 'orgCreation') return v === 'admins' ? '운영자만' : '누구나';
  if (key === 'allowedEmailDomains') return Array.isArray(v) && v.length ? v.join(', ') : '제한 없음';
  if (typeof v === 'boolean') return v ? '켬' : '끔';
  return String(v);
}
