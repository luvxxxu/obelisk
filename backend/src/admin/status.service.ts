import { BadRequestException, HttpException, Injectable } from '@nestjs/common';
import { SIGNUP_MODE_LABEL_KO, type BackupStatus, type ServerCheck, type ServerStatus, type ServerUsage, type SignupMode, type UpdateStatus } from '@obelisk/core';
import { sql } from 'drizzle-orm';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { actionMail, mailAvailable, sendMail } from '../common/mail';
import { rateLimiter } from '../common/rate-limit';
import { config } from '../config';
import { InjectDb, type Db } from '../db/db.module';
import type { UserRow } from '../db/schema';
import { ServerSettingsService } from '../server/settings.service';
import { buildInfo } from './version';

const UPDATE_EVERY_MS = 6 * 3_600_000;
const testMailLimit = rateLimiter(5, 10 * 60_000);
const updateNowLimit = rateLimiter(1, 60_000);
const BACKUP_FILE = /^obelisk-\d{8}-\d{6}\.dump$/;

interface GhCommit {
  sha: string;
  commit: { message: string; committer?: { date?: string } | null; author?: { date?: string } | null };
}

const firstLine = (m: string) => m.split('\n')[0]!.slice(0, 200);
const commitOf = (c: GhCommit) => ({
  commit: c.sha,
  date: c.commit.committer?.date ?? c.commit.author?.date ?? null,
  message: firstLine(c.commit.message),
});

/** The secret-free view of SMTP_URL: just where mail goes. */
function smtpHost(url: string | null): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.port ? `${u.hostname}:${u.port}` : u.hostname;
  } catch {
    return '(읽을 수 없는 주소)';
  }
}

/**
 * 서버 관리 → 개요: is this server set up right, how big is it, are backups landing, is it up to date.
 * Never shows a secret's value, only whether it is set.
 */
@Injectable()
export class StatusService {
  private update: UpdateStatus | null = null;
  private checking: Promise<UpdateStatus> | null = null;

  constructor(
    @InjectDb() private readonly db: Db,
    private readonly settings: ServerSettingsService,
  ) {}

  async status(): Promise<ServerStatus> {
    const r = await this.settings.row();
    const [usage, backup, update] = await Promise.all([this.usage(), this.backup(), this.updateStatus(r.updateCheck)]);
    return {
      version: buildInfo(),
      update,
      checks: this.checks(this.settings.signupMode(r), r.signupMode === null, backup),
      usage,
      backup,
      mail: { available: mailAvailable(), toLog: mailAvailable() && !config.smtpUrl, from: config.mailFrom, host: smtpHost(config.smtpUrl) },
    };
  }

  // ───────────────────────────── configuration

  private checks(mode: SignupMode, fromEnv: boolean, backup: BackupStatus): ServerCheck[] {
    const out: ServerCheck[] = [];
    const prod = config.production;
    out.push({
      id: 'env',
      label: '실행 모드',
      state: prod ? 'ok' : 'info',
      value: prod ? '운영 (production)' : '개발 (development)',
      ...(prod ? {} : { hint: '개발 모드에서는 메일이 로그로 나가고 내부망 주소도 허용돼요.' }),
    });

    const url = config.publicUrl;
    const publicSet = !!process.env.PUBLIC_URL;
    out.push({
      id: 'public_url',
      label: 'PUBLIC_URL',
      state: !publicSet && prod ? 'error' : url.includes('example.com') ? 'warn' : prod && !url.startsWith('https://') ? 'warn' : 'ok',
      value: url,
      hint: !publicSet && prod
        ? '설정되지 않아 OAuth·MCP·메일 링크가 localhost를 가리켜요.'
        : url.includes('example.com')
          ? '예시 도메인이 그대로예요.'
          : prod && !url.startsWith('https://')
            ? 'https가 아니면 로그인 쿠키가 Secure가 아니고 Claude·ChatGPT 연결이 거절돼요.'
            : undefined,
    });

    const key = process.env.SECRET_KEY?.trim() ?? '';
    out.push({
      id: 'secret_key',
      label: 'SECRET_KEY',
      state: !key ? (prod ? 'warn' : 'info') : key.length < 32 ? 'warn' : 'ok',
      value: !key ? '설정 안 됨' : key.length < 32 ? '짧음' : '설정됨',
      hint: !key
        ? 'Jev 키와 웹훅 서명 키가 DB 비밀번호에서 파생한 키로 봉인돼요. openssl rand -base64 32로 만든 값을 넣으세요.'
        : key.length < 32
          ? '32자 이상의 무작위 값을 쓰세요.'
          : undefined,
    });
    if (process.env.SECRET_KEY_PREVIOUS?.trim()) {
      out.push({
        id: 'secret_key_previous',
        label: 'SECRET_KEY_PREVIOUS',
        state: 'warn',
        value: '설정됨',
        hint: '키 교체가 끝났다면(로그에 re-sealed가 찍혔다면) 지워도 돼요.',
      });
    }

    out.push({
      id: 'smtp',
      label: 'SMTP_URL',
      state: config.smtpUrl ? 'ok' : prod ? 'warn' : 'info',
      value: config.smtpUrl ? `${smtpHost(config.smtpUrl)} · 보내는 주소 ${config.mailFrom}` : prod ? '설정 안 됨' : '설정 안 됨 (메일은 로그로)',
      hint: config.smtpUrl
        ? undefined
        : prod
          ? '비밀번호 찾기, 메일 확인, 가입 승인 알림, 전체 메일이 꺼져 있어요.'
          : '메일은 보내지 않고 백엔드 로그에 찍어요.',
    });

    out.push({
      id: 'signup',
      label: '가입',
      state: mode === 'open' ? 'info' : 'ok',
      value: `${SIGNUP_MODE_LABEL_KO[mode]}${fromEnv ? ` (SIGNUP_MODE=${config.signupModeRaw ?? 'first'})` : ' (서버 관리에서 정함)'}`,
      ...(mode === 'open' ? { hint: '누구나 계정을 만들 수 있어요.' } : {}),
    });

    const open = [
      config.webhookAllowPrivate && 'WEBHOOK_ALLOW_PRIVATE',
      config.jevAllowPrivate && 'JEV_ALLOW_PRIVATE',
      config.migrationAllowPrivate && 'MIGRATION_ALLOW_PRIVATE',
    ].filter(Boolean) as string[];
    if (prod) {
      out.push({
        id: 'private',
        label: '내부망 접근',
        state: open.length ? 'warn' : 'ok',
        value: open.length ? open.join(', ') : '막힘',
        ...(open.length ? { hint: '웹훅·Jev·이전 링크가 서버 내부망 주소로도 요청을 보낼 수 있어요. 필요할 때만 켜세요.' } : {}),
      });
    }

    out.push({
      id: 'backup',
      label: '백업',
      state: backup.state === 'ok' ? 'ok' : backup.state === 'unavailable' ? (prod ? 'warn' : 'info') : backup.state === 'stale' ? 'warn' : 'error',
      value:
        backup.state === 'unavailable'
          ? '백업 폴더를 볼 수 없음'
          : backup.latest
            ? `${backup.count}개 · 최근 ${backup.latest.at.slice(0, 16).replace('T', ' ')} UTC`
            : '백업 없음',
      hint:
        backup.state === 'unavailable'
          ? `backend에 백업 볼륨이 연결되지 않았어요(${backup.dir}). docker-compose.yml을 최신으로 맞추세요.`
          : backup.state === 'stale'
            ? '마지막 백업이 하루가 넘었어요. backup 서비스 로그를 확인하세요.'
            : backup.state === 'missing'
              ? 'backup 서비스가 아직 덤프를 만들지 않았어요.'
              : undefined,
    });
    return out;
  }

  // ───────────────────────────── size of things

  private async usage(): Promise<ServerUsage> {
    const rows = await this.db.execute<Record<string, string | number | null>>(sql`
      select
        (select count(*) from users)::int as users,
        (select count(*) from users where last_seen_at > now() - interval '7 days')::int as active_week,
        (select count(*) from users where last_seen_at > now() - interval '30 days')::int as active_month,
        (select count(*) from users where pending_approval_at is not null and suspended_at is null)::int as pending,
        (select count(*) from users where suspended_at is not null)::int as suspended,
        (select count(*) from users where admin)::int as admins,
        (select count(*) from workspaces where kind = 'org')::int as orgs,
        (select count(*) from projects)::int as projects,
        (select count(*) from tasks)::int as tasks,
        (select count(*) from tasks where status in ('todo', 'doing'))::int as open_tasks,
        pg_database_size(current_database())::bigint as db_bytes,
        (select count(*) from avatars)::int as photos,
        (select coalesce(sum(octet_length(data)), 0) from avatars)::bigint as photo_bytes,
        (select count(*) from webhooks)::int as webhooks,
        (select count(*) from webhooks where enabled and failure_count > 0)::int as failing_webhooks,
        (select count(*) from webhooks where not enabled and disabled_reason is not null)::int as disabled_webhooks,
        (select count(*) from api_tokens where revoked_at is null)::int as api_tokens,
        (select count(*) from oauth_grants where revoked_at is null and refresh_expires_at > now())::int as ai_connections
    `);
    const r = rows[0] ?? {};
    const n = (k: string) => Number(r[k] ?? 0);
    return {
      users: n('users'),
      activeWeek: n('active_week'),
      activeMonth: n('active_month'),
      pending: n('pending'),
      suspended: n('suspended'),
      admins: n('admins'),
      orgs: n('orgs'),
      projects: n('projects'),
      tasks: n('tasks'),
      openTasks: n('open_tasks'),
      dbBytes: n('db_bytes'),
      photos: n('photos'),
      photoBytes: n('photo_bytes'),
      webhooks: n('webhooks'),
      failingWebhooks: n('failing_webhooks'),
      disabledWebhooks: n('disabled_webhooks'),
      apiTokens: n('api_tokens'),
      aiConnections: n('ai_connections'),
    };
  }

  // ───────────────────────────── backups (the compose file's `backup` service, mounted read-only)

  async backup(): Promise<BackupStatus> {
    const dir = config.backupDir;
    const base: BackupStatus = { state: 'unavailable', dir, count: 0, totalBytes: 0, latest: null, keepDays: config.backupKeepDays };
    let names: string[];
    try {
      names = (await readdir(dir)).filter((n) => BACKUP_FILE.test(n));
    } catch {
      return base;
    }
    const files = (
      await Promise.all(
        names.map(async (name) => {
          try {
            const st = await stat(join(dir, name));
            return { name, at: st.mtime, bytes: st.size };
          } catch {
            return null;
          }
        }),
      )
    ).filter((f): f is { name: string; at: Date; bytes: number } => !!f);
    if (!files.length) return { ...base, state: 'missing' };
    files.sort((a, b) => b.at.getTime() - a.at.getTime());
    const latest = files[0]!;
    return {
      ...base,
      state: Date.now() - latest.at.getTime() > 26 * 3_600_000 ? 'stale' : 'ok',
      count: files.length,
      totalBytes: files.reduce((s, f) => s + f.bytes, 0),
      latest: { name: latest.name, at: latest.at.toISOString(), bytes: latest.bytes },
    };
  }

  // ───────────────────────────── updates (GitHub, at most every few hours)

  private base(enabled: boolean): UpdateStatus {
    return {
      enabled,
      state: enabled ? 'unknown' : 'off',
      repo: config.updateRepo,
      branch: config.updateBranch,
      checkedAt: null,
      behindBy: null,
      latest: null,
      commits: [],
      url: `https://github.com/${config.updateRepo}`,
    };
  }

  private async updateStatus(enabled: boolean, force = false): Promise<UpdateStatus> {
    if (!enabled) return this.base(false);
    const fresh = this.update?.checkedAt && Date.now() - Date.parse(this.update.checkedAt) < UPDATE_EVERY_MS;
    if (this.update && fresh && !force) return this.update;
    // Never make the page wait on GitHub longer than the request itself allows.
    this.checking ??= this.fetchUpdate().finally(() => (this.checking = null));
    this.update = await this.checking;
    return this.update;
  }

  async checkNow(user: UserRow): Promise<UpdateStatus> {
    try {
      updateNowLimit(user.id);
    } catch {
      throw new HttpException('조금 전에 확인했어요. 1분 뒤에 다시 눌러 주세요.', 429);
    }
    const r = await this.settings.row();
    if (!r.updateCheck) throw new BadRequestException('업데이트 확인이 꺼져 있어요');
    return this.updateStatus(true, true);
  }

  private async gh<T>(path: string): Promise<T> {
    const res = await fetch(`https://api.github.com/repos/${config.updateRepo}${path}`, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'obelisk-update-check', 'x-github-api-version': '2022-11-28' },
      redirect: 'follow',
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw Object.assign(new Error(`GitHub ${res.status}`), { status: res.status });
    return (await res.json()) as T;
  }

  private async fetchUpdate(): Promise<UpdateStatus> {
    const out = this.base(true);
    const { commit } = buildInfo();
    const branch = encodeURIComponent(config.updateBranch);
    out.checkedAt = new Date().toISOString();
    try {
      if (commit) {
        try {
          const cmp = await this.gh<{ ahead_by: number; commits: GhCommit[]; html_url: string; base_commit: GhCommit }>(
            `/compare/${commit}...${branch}?per_page=100`,
          );
          out.behindBy = cmp.ahead_by;
          out.state = cmp.ahead_by > 0 ? 'behind' : 'current';
          if (cmp.ahead_by === 0) {
            out.latest = commitOf(cmp.base_commit);
            out.url = `https://github.com/${config.updateRepo}/tree/${branch}`;
            return out;
          }
          // The page holds the oldest commits first; list them only when it holds all of them.
          if (cmp.ahead_by <= cmp.commits.length) out.commits = cmp.commits.map(commitOf).reverse().slice(0, 8);
          out.latest = out.commits[0] ?? commitOf(await this.gh<GhCommit>(`/commits/${branch}`));
          out.url = cmp.html_url;
          return out;
        } catch (e) {
          // This build's commit isn't in that repository (a fork, local commits): just show the latest.
          if ((e as { status?: number }).status !== 404) throw e;
        }
      }
      const head = await this.gh<GhCommit>(`/commits/${branch}`);
      out.latest = commitOf(head);
      out.state = commit && head.sha === commit ? 'current' : 'unknown';
      out.url = `https://github.com/${config.updateRepo}/commits/${branch}`;
      return out;
    } catch (e) {
      out.state = 'error';
      out.error = (e as { status?: number }).status === 403 ? 'GitHub 요청 한도에 걸렸어요. 잠시 뒤 다시 확인해요.' : 'GitHub에 연결하지 못했어요';
      return out;
    }
  }

  // ───────────────────────────── mail

  async testMail(user: UserRow): Promise<{ to: string; toLog: boolean }> {
    if (!mailAvailable()) throw new BadRequestException('SMTP_URL이 설정되지 않았어요');
    try {
      testMailLimit(user.id);
    } catch {
      throw new HttpException('테스트 메일을 너무 자주 보냈어요. 잠시 후 다시 시도하세요.', 429);
    }
    try {
      await sendMail(
        actionMail({
          to: user.email,
          subject: 'Obelisk 테스트 메일',
          heading: '메일이 잘 도착했어요',
          lines: [`${config.publicUrl}의 Obelisk 서버가 보낸 테스트 메일이에요.`, `보내는 주소: ${config.mailFrom}`],
          action: '서버 관리 열기',
          url: `${config.publicUrl}/admin`,
          footer: '서버 관리 → 개요에서 보낸 메일이에요.',
        }),
      );
    } catch (err) {
      throw new BadRequestException(`메일을 보내지 못했어요: ${(err as Error).message.slice(0, 200)}`);
    }
    return { to: user.email, toLog: !config.smtpUrl };
  }
}
