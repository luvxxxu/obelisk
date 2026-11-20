'use client';

import type { AdminOrgList, CheckState, ServerSettings, ServerStatus, UpdateStatus } from '@obelisk/core';
import Link from 'next/link';
import { useState } from 'react';
import { Icon, type IconName } from '@/components/Icon';
import { Skeleton, Spinner, Switch, ui } from '@/components/primitives';
import { api } from '@/lib/api';
import { cx, relativeTime } from '@/lib/format';
import { toast } from '@/lib/toast';
import { SettingsRow, SettingsSection } from '../settings/SettingsNav';
import base from '../settings/settings.module.css';
import { AdminPage, bytes, dateOnly, dateTime, num, useAdmin } from './shared';
import s from './admin.module.css';

const STATE_ICON: Record<CheckState, IconName> = { ok: 'checkCircle', warn: 'alert', error: 'alertCircle', info: 'info' };

/** 서버 관리 → 개요: what needs a look, how big the server is, its version, backups and configuration. */
export default function AdminOverviewPage() {
  const status = useAdmin<ServerStatus>('/api/admin/status');
  const settings = useAdmin<ServerSettings>('/api/admin/settings');
  const ownerless = useAdmin<AdminOrgList>('/api/admin/orgs?ownerless=true&limit=1');
  const st = status.data;

  return (
    <AdminPage lead="이 서버의 상태와 설정을 봐요. 다른 사람의 작업 내용은 운영자도 볼 수 없어요.">
      {status.error && (
        <div className={ui.alert} data-tone="danger" role="alert">
          <Icon name="alertCircle" size={16} />
          <div className={ui.alertTitle}>불러오지 못했어요</div>
          <div className={ui.alertDescription}>{status.error}</div>
        </div>
      )}

      {!st ? (
        <OverviewSkeleton />
      ) : (
        <>
          <Attention status={st} ownerless={ownerless.data?.ownerless ?? 0} />
          <Usage status={st} />
          <Version
            update={st.update}
            version={st.version}
            enabled={settings.data?.updateCheck ?? st.update.enabled}
            onToggle={async (on) => {
              try {
                settings.setData(await api<ServerSettings>('PATCH', '/api/admin/settings', { updateCheck: on }));
                await status.reload();
              } catch (e) {
                toast.error((e as Error).message);
              }
            }}
            onChecked={(update) => status.setData((cur) => (cur ? { ...cur, update } : cur))}
          />
          <Backups status={st} />
          <Checks status={st} />
        </>
      )}
    </AdminPage>
  );
}

function OverviewSkeleton() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Skeleton style={{ height: 20, width: 160 }} />
      <Skeleton style={{ height: 180 }} />
      <Skeleton style={{ height: 120 }} />
    </div>
  );
}

/** Only what an operator should act on, each with the way there. Quiet when there is nothing. */
function Attention({ status, ownerless }: { status: ServerStatus; ownerless: number }) {
  const items: { key: string; state: CheckState; text: string; detail?: string; href?: string; action?: string }[] = [];
  if (status.usage.pending) {
    items.push({ key: 'pending', state: 'warn', text: `가입 승인을 기다리는 사람이 ${status.usage.pending}명 있어요`, href: '/admin/users?filter=pending', action: '보기' });
  }
  if (ownerless) {
    items.push({
      key: 'ownerless',
      state: 'warn',
      text: `쓸 수 있는 소유자가 없는 조직이 ${ownerless}곳 있어요`,
      detail: '소유자가 모두 정지됐어요. 멤버 중 한 명을 소유자로 정할 수 있어요.',
      href: '/admin/orgs?ownerless=1',
      action: '보기',
    });
  }
  if (status.update.state === 'behind') {
    items.push({
      key: 'update',
      state: 'info',
      text: `새 버전이 있어요 · 커밋 ${status.update.behindBy ?? ''}개`,
      detail: '아래 버전 항목에서 바뀐 내용을 볼 수 있어요.',
    });
  }
  for (const c of status.checks) {
    if (c.state === 'warn' || c.state === 'error') items.push({ key: c.id, state: c.state, text: `${c.label} · ${c.value}`, detail: c.hint });
  }
  if (status.usage.failingWebhooks) {
    items.push({ key: 'hooks', state: 'warn', text: `전달에 실패하고 있는 웹훅이 ${status.usage.failingWebhooks}개 있어요`, detail: '각 공간의 설정 → 웹훅에서 확인할 수 있어요.' });
  }

  return (
    <SettingsSection title="확인할 것">
      {items.length ? (
        <ul className={s.attention}>
          {items.map((i) => (
            <li key={i.key} className={s.attentionRow}>
              <Icon name={STATE_ICON[i.state]} size={16} className={s.stateIcon} data-state={i.state} />
              <span className={s.attentionText}>
                {i.text}
                {i.detail && <small>{i.detail}</small>}
              </span>
              {i.href && (
                <Link href={i.href} className={cx(ui.btn, ui.outline, ui.sm)}>
                  {i.action}
                </Link>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className={s.calm}>
          <Icon name="checkCircle" size={16} className={s.stateIcon} data-state="ok" />
          지금은 따로 확인할 것이 없어요.
        </p>
      )}
    </SettingsSection>
  );
}

function Usage({ status }: { status: ServerStatus }) {
  const u = status.usage;
  const cells: { label: string; value: string; meta?: string }[] = [
    { label: '사용자', value: num(u.users), meta: `최근 7일 ${num(u.activeWeek)}명 · 30일 ${num(u.activeMonth)}명` },
    { label: '조직', value: num(u.orgs), meta: `운영자 ${num(u.admins)}명` },
    { label: '작업', value: num(u.tasks), meta: `진행 중 ${num(u.openTasks)} · 프로젝트 ${num(u.projects)}` },
    { label: '데이터베이스', value: bytes(u.dbBytes), meta: `사진 ${num(u.photos)}장 · ${bytes(u.photoBytes)}` },
    { label: '승인 대기', value: num(u.pending) },
    { label: '정지된 계정', value: num(u.suspended) },
    { label: 'AI 연결', value: num(u.aiConnections), meta: `API 토큰 ${num(u.apiTokens)}개` },
    {
      label: '웹훅',
      value: num(u.webhooks),
      meta: u.failingWebhooks || u.disabledWebhooks ? `실패 중 ${num(u.failingWebhooks)} · 꺼짐 ${num(u.disabledWebhooks)}` : '모두 정상',
    },
  ];
  return (
    <SettingsSection title="사용량" lead="숫자와 크기만 모아 봐요. 무엇을 적었는지는 세지 않아요.">
      <div className={s.stats}>
        {cells.map((c) => (
          <div key={c.label} className={s.stat}>
            <span className={s.statLabel}>{c.label}</span>
            <span className={s.statValue}>{c.value}</span>
            {c.meta && <span className={s.statMeta}>{c.meta}</span>}
          </div>
        ))}
      </div>
    </SettingsSection>
  );
}

function Version({
  update,
  version,
  enabled,
  onToggle,
  onChecked,
}: {
  update: UpdateStatus;
  version: ServerStatus['version'];
  enabled: boolean;
  onToggle: (on: boolean) => Promise<void>;
  onChecked: (u: UpdateStatus) => void;
}) {
  const [checking, setChecking] = useState(false);
  const check = async () => {
    setChecking(true);
    try {
      onChecked(await api<UpdateStatus>('POST', '/api/admin/status/update-check'));
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setChecking(false);
    }
  };

  const summary =
    update.state === 'off'
      ? '확인하지 않아요'
      : update.state === 'current'
        ? '최신 버전이에요'
        : update.state === 'behind'
          ? `새 커밋 ${update.behindBy}개가 있어요`
          : update.state === 'error'
            ? (update.error ?? '확인하지 못했어요')
            : version.commit
              ? '이 빌드의 커밋을 저장소에서 찾지 못했어요'
              : '이 빌드의 커밋을 알 수 없어요';

  return (
    <SettingsSection
      title="버전"
      lead={
        <>
          {update.repo}의 {update.branch} 브랜치와 비교해요. 업데이트는 배포 도구에서 다시 배포하면 돼요.
        </>
      }
      action={
        enabled ? (
          <button className={cx(ui.btn, ui.outline, ui.sm)} onClick={() => void check()} disabled={checking}>
            {checking && <Spinner label="확인 중" />}
            지금 확인
          </button>
        ) : undefined
      }
    >
      <SettingsRow
        label="이 서버"
        description={[
          update.state === 'current' && update.latest?.message ? update.latest.message : null,
          version.builtAt ? `${dateTime(version.builtAt)}에 빌드` : null,
        ]
          .filter(Boolean)
          .join(' · ') || undefined}
      >
        <span className={cx(s.mono, base.value)}>{version.commit ? version.commit.slice(0, 7) : '알 수 없음'}</span>
      </SettingsRow>
      <SettingsRow label="저장소" description={update.checkedAt ? `${relativeTime(update.checkedAt)} 확인` : undefined}>
        <span className={base.value}>
          {update.url && update.state !== 'off' ? (
            <a href={update.url} target="_blank" rel="noreferrer noopener" className={ui.link}>
              {summary}
            </a>
          ) : (
            summary
          )}
        </span>
      </SettingsRow>
      {update.state === 'unknown' && update.latest && (
        <SettingsRow label="저장소 최신 커밋" description={update.latest.message}>
          <span className={cx(s.mono, base.value)}>{update.latest.commit.slice(0, 7)}</span>
        </SettingsRow>
      )}
      {update.commits.length > 0 && (
        <ul className={s.commits} aria-label="새 커밋">
          {update.commits.map((c) => (
            <li key={c.commit} className={s.commit}>
              <span className={s.mono}>{c.commit.slice(0, 7)}</span>
              <span className={s.commitMsg}>{c.message}</span>
              {c.date && <span className={s.commitDate}>{dateOnly(c.date)}</span>}
            </li>
          ))}
        </ul>
      )}
      <SettingsRow label="업데이트 확인" description="몇 시간마다 GitHub에 이 서버의 커밋을 물어봐요. 끄면 서버가 GitHub에 요청하지 않아요.">
        <Switch checked={enabled} onChange={(v) => void onToggle(v)} label="업데이트 확인" />
      </SettingsRow>
    </SettingsSection>
  );
}

function Backups({ status }: { status: ServerStatus }) {
  const b = status.backup;
  const state: CheckState = b.state === 'ok' ? 'ok' : b.state === 'unavailable' ? 'info' : b.state === 'stale' ? 'warn' : 'error';
  return (
    <SettingsSection title="백업" lead="docker-compose의 backup 서비스가 매일 만드는 데이터베이스 덤프예요. 복구 방법은 README의 ‘백업과 복구’에 있어요.">
      <SettingsRow
        label={
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <Icon name={STATE_ICON[state]} size={15} className={s.stateIcon} data-state={state} />
            마지막 백업
          </span>
        }
        description={
          b.state === 'unavailable'
            ? `백업 폴더(${b.dir})를 볼 수 없어요. 최신 docker-compose.yml은 backend에 백업 볼륨을 읽기 전용으로 연결해요.`
            : b.state === 'missing'
              ? '아직 백업이 없어요.'
              : b.state === 'stale'
                ? '하루가 넘도록 새 백업이 없어요. backup 서비스 로그를 확인하세요.'
                : undefined
        }
      >
        <span className={base.value}>{b.latest ? `${dateTime(b.latest.at)} · ${bytes(b.latest.bytes)}` : '없음'}</span>
      </SettingsRow>
      {b.state !== 'unavailable' && (
        <SettingsRow label="보관 중" description={b.keepDays ? `${b.keepDays}일이 지난 백업은 지워요 (BACKUP_KEEP_DAYS).` : undefined}>
          <span className={base.value}>
            {b.count}개 · {bytes(b.totalBytes)}
          </span>
        </SettingsRow>
      )}
    </SettingsSection>
  );
}

function Checks({ status }: { status: ServerStatus }) {
  const [sending, setSending] = useState(false);
  const test = async () => {
    setSending(true);
    try {
      const r = await api<{ to: string; toLog: boolean }>('POST', '/api/admin/test-mail');
      toast.success(r.toLog ? '메일 대신 백엔드 로그에 찍었어요' : `${r.to}(으)로 테스트 메일을 보냈어요`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSending(false);
    }
  };
  return (
    <SettingsSection title="설정 점검" lead="환경 변수로 정하는 값이에요. 바꾸려면 배포 도구에서 고친 뒤 다시 배포하세요. 비밀값은 설정 여부만 보여요.">
      {status.checks
        .filter((c) => c.id !== 'backup')
        .map((c) => (
        <SettingsRow
          key={c.id}
          label={
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
              <Icon name={STATE_ICON[c.state]} size={15} className={s.stateIcon} data-state={c.state} />
              {c.label}
            </span>
          }
          description={c.hint}
        >
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            <span className={base.value}>{c.value}</span>
            {c.id === 'smtp' && status.mail.available && (
              <button className={cx(ui.btn, ui.outline, ui.sm)} onClick={() => void test()} disabled={sending}>
                {sending ? '보내는 중…' : '테스트 메일'}
              </button>
            )}
          </span>
        </SettingsRow>
      ))}
    </SettingsSection>
  );
}
