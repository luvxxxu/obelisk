'use client';

import {
  ADMIN_STATE_LABEL_KO,
  ADMIN_USER_FILTERS,
  type AccountDeletionPreview,
  type AdminUser,
  type AdminUserFilter,
  type AdminUserList,
} from '@obelisk/core';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef, useState } from 'react';
import { CopyField } from '@/components/Copy';
import { Icon } from '@/components/Icon';
import { Avatar, Badge, ConfirmModal, Modal, Popover, Spinner, ui, useDisclosure, type BadgeTone } from '@/components/primitives';
import { api } from '@/lib/api';
import { cx, relativeTime } from '@/lib/format';
import { useApp } from '@/lib/store';
import { toast } from '@/lib/toast';
import { SettingsSection } from '../../settings/SettingsNav';
import { AdminPage, dateOnly, num } from '../shared';
import s from '../admin.module.css';

const FILTER_LABEL: Record<AdminUserFilter, string> = {
  all: '전체',
  pending: '승인 대기',
  unverified: '메일 확인 전',
  suspended: '정지됨',
  admins: '운영자',
};

const STATE_TONE: Record<AdminUser['state'], BadgeTone> = {
  active: 'secondary',
  pending: 'warn',
  unverified: 'secondary',
  suspended: 'danger',
};

const PAGE = 50;

export default function AdminUsersPage() {
  return (
    <Suspense fallback={null}>
      <AdminUsers />
    </Suspense>
  );
}

type Dialog =
  | { kind: 'reset'; user: AdminUser }
  | { kind: 'suspend'; user: AdminUser }
  | { kind: 'delete'; user: AdminUser }
  | { kind: 'reject'; user: AdminUser }
  | { kind: 'admin'; user: AdminUser; admin: boolean }
  | null;

function AdminUsers() {
  const params = useSearchParams();
  const router = useRouter();
  const { user: me } = useApp();
  const initial = params.get('filter');
  const [filter, setFilter] = useState<AdminUserFilter>(ADMIN_USER_FILTERS.includes(initial as AdminUserFilter) ? (initial as AdminUserFilter) : 'all');
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [data, setData] = useState<AdminUserList | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const seq = useRef(0);

  // Type, pause, search.
  useEffect(() => {
    const t = window.setTimeout(() => setQuery(q.trim()), 250);
    return () => window.clearTimeout(t);
  }, [q]);

  const url = (offset: number) =>
    `/api/admin/users?filter=${filter}&offset=${offset}&limit=${PAGE}${query ? `&q=${encodeURIComponent(query)}` : ''}`;

  const load = async () => {
    const mine = ++seq.current;
    try {
      const d = await api<AdminUserList>('GET', url(0));
      if (mine === seq.current) {
        setData(d);
        setError(null);
      }
    } catch (e) {
      if (mine === seq.current) setError((e as Error).message);
    }
  };

  useEffect(() => {
    void load();
    // The address keeps the filter, so the link in the "가입 신청" mail lands on it.
    router.replace(filter === 'all' ? '/admin/users' : `/admin/users?filter=${filter}`, { scroll: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter, query]);

  const more = async () => {
    if (!data) return;
    setLoadingMore(true);
    try {
      const d = await api<AdminUserList>('GET', url(data.users.length));
      setData({ ...d, users: [...data.users, ...d.users] });
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setLoadingMore(false);
    }
  };

  /** Swap one account in place after an action (or drop it when it no longer fits the filter). */
  const replace = (u: AdminUser | null, id: string) => {
    setData((d) => {
      if (!d) return d;
      const fits = u && (filter === 'all' || (filter === 'admins' ? u.admin : filter === u.state));
      if (fits) return { ...d, users: d.users.map((x) => (x.id === id ? u : x)) };
      const had = d.users.some((x) => x.id === id);
      return { ...d, users: d.users.filter((x) => x.id !== id), total: had ? Math.max(0, d.total - 1) : d.total };
    });
    // Counts on the filter tabs.
    void api<AdminUserList>('GET', `/api/admin/users?limit=1${query ? `&q=${encodeURIComponent(query)}` : ''}`)
      .then((r) => setData((d) => (d ? { ...d, counts: r.counts } : d)))
      .catch(() => {});
  };

  const act = async (id: string, label: string, run: () => Promise<{ user?: AdminUser } | void>, done: string) => {
    setBusy(id);
    try {
      const r = await run();
      replace(r && 'user' in r && r.user ? r.user : null, id);
      toast.success(done);
    } catch (e) {
      toast.error(`${label}: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  };

  const approve = (u: AdminUser) =>
    act(u.id, '승인하지 못했어요', () => api<{ user: AdminUser }>('POST', `/api/admin/users/${u.id}/approve`), `${u.name}님의 가입을 승인했어요`);

  const counts = data?.counts;

  return (
    <AdminPage lead="이 서버의 계정이에요. 이름, 주소, 날짜와 개수만 보이고 작업 내용은 보이지 않아요.">
      <SettingsSection title={counts ? `사용자 ${num(counts.all)}명` : '사용자'}>
        <div className={s.toolbar}>
          <div className={s.search}>
            <Icon name="search" size={15} />
            <input placeholder="이름이나 이메일로 찾기" aria-label="사용자 찾기" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <div className={cx(ui.segmented, s.filters)} data-size="sm" role="group" aria-label="보기">
            {ADMIN_USER_FILTERS.map((f) => (
              <button key={f} type="button" className={ui.segment} aria-pressed={filter === f} onClick={() => setFilter(f)}>
                {FILTER_LABEL[f]}
                {counts && f !== 'all' && counts[f] > 0 && <span className={s.count}>{counts[f]}</span>}
              </button>
            ))}
          </div>
        </div>

        {error && (
          <div className={ui.alert} data-tone="danger" role="alert">
            <Icon name="alertCircle" size={16} />
            <div className={ui.alertDescription}>{error}</div>
          </div>
        )}

        {!data ? (
          <div className={s.empty}>
            <Spinner />
          </div>
        ) : data.users.length === 0 ? (
          <p className={s.empty}>{query ? `‘${query}’에 맞는 계정이 없어요` : filter === 'pending' ? '승인을 기다리는 사람이 없어요' : '계정이 없어요'}</p>
        ) : (
          <ul className={s.people}>
            {data.users.map((u) => (
              <UserRow
                key={u.id}
                u={u}
                me={u.id === me?.id}
                busy={busy === u.id}
                onApprove={() => void approve(u)}
                onDialog={setDialog}
                onUnsuspend={() =>
                  void act(u.id, '정지를 풀지 못했어요', () => api<{ user: AdminUser }>('POST', `/api/admin/users/${u.id}/unsuspend`), `${u.name}님의 정지를 풀었어요`)
                }
                onSkipVerification={() =>
                  void act(
                    u.id,
                    '허용하지 못했어요',
                    () => api<{ user: AdminUser }>('POST', `/api/admin/users/${u.id}/skip-verification`),
                    `${u.name}님은 이제 메일 확인 없이 쓸 수 있어요`,
                  )
                }
              />
            ))}
          </ul>
        )}

        {data && data.users.length < data.total && (
          <div className={s.more}>
            <button className={cx(ui.btn, ui.ghost, ui.sm)} onClick={() => void more()} disabled={loadingMore}>
              {loadingMore ? '불러오는 중…' : `더 보기 (${num(data.total - data.users.length)}명 더)`}
            </button>
          </div>
        )}
      </SettingsSection>

      <ResetLinkDialog user={dialog?.kind === 'reset' ? dialog.user : null} onClose={() => setDialog(null)} />
      <SuspendDialog
        user={dialog?.kind === 'suspend' ? dialog.user : null}
        onClose={() => setDialog(null)}
        onDone={(u) => {
          replace(u, u.id);
          toast.success(`${u.name}님을 정지했어요`);
        }}
      />
      <DeleteDialog
        user={dialog?.kind === 'delete' ? dialog.user : null}
        onClose={() => setDialog(null)}
        onDone={(u) => {
          replace(null, u.id);
          toast.success(`${u.email} 계정을 삭제했어요`);
        }}
      />
      <ConfirmModal
        open={dialog?.kind === 'reject'}
        onClose={() => setDialog(null)}
        title={dialog?.kind === 'reject' ? `${dialog.user.name}님의 가입을 거절할까요?` : ''}
        confirmLabel="거절"
        body="신청하며 만든 계정이 바로 삭제돼요. 다시 가입하려면 처음부터 신청해야 해요."
        onConfirm={() => {
          if (dialog?.kind !== 'reject') return;
          const u = dialog.user;
          void act(u.id, '거절하지 못했어요', () => api('POST', `/api/admin/users/${u.id}/reject`), `${u.name}님의 가입을 거절했어요`);
        }}
      />
      <AdminRoleDialog
        state={dialog?.kind === 'admin' ? dialog : null}
        onClose={() => setDialog(null)}
        onConfirm={(u, admin) =>
          void act(
            u.id,
            admin ? '운영자로 지정하지 못했어요' : '운영자에서 해제하지 못했어요',
            () => api<{ user: AdminUser }>('POST', `/api/admin/users/${u.id}/admin`, { admin }),
            admin ? `${u.name}님을 운영자로 지정했어요` : `${u.name}님을 운영자에서 해제했어요`,
          )
        }
      />
    </AdminPage>
  );
}

function UserRow({
  u,
  me,
  busy,
  onApprove,
  onDialog,
  onUnsuspend,
  onSkipVerification,
}: {
  u: AdminUser;
  me: boolean;
  busy: boolean;
  onApprove: () => void;
  onDialog: (d: Dialog) => void;
  onUnsuspend: () => void;
  onSkipVerification: () => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const menu = useDisclosure();
  const pick = (fn: () => void) => () => {
    menu.close();
    fn();
  };
  const meta = [
    u.email,
    `${dateOnly(u.createdAt)} 가입`,
    u.lastSeenAt ? `${relativeTime(u.lastSeenAt)} 접속` : '접속 기록 없음',
    u.orgs ? `조직 ${u.orgs}${u.ownedOrgs ? ` (소유 ${u.ownedOrgs})` : ''}` : null,
    u.aiConnections || u.apiTokens ? `AI 연결 ${u.aiConnections} · 토큰 ${u.apiTokens}` : null,
  ].filter(Boolean);

  return (
    <li className={s.person}>
      <Avatar name={u.name} src={u.avatarUrl} />
      <div className={s.personText}>
        <span className={s.personName}>
          <span>
            {u.name}
            {me && <span className={s.muted}> (나)</span>}
          </span>
          {u.admin && (
            <Badge tone="outline">
              <Icon name="shield" size={11} /> 운영자
            </Badge>
          )}
          {u.state !== 'active' && <Badge tone={STATE_TONE[u.state]}>{ADMIN_STATE_LABEL_KO[u.state]}</Badge>}
          {u.emailVerified && <Badge tone="secondary">메일 확인됨</Badge>}
        </span>
        <span className={s.personMeta}>{meta.join(' · ')}</span>
      </div>
      <div className={s.personActions}>
        {busy && <Spinner />}
        {u.state === 'pending' && (
          <>
            <button className={cx(ui.btn, ui.primary, ui.sm)} onClick={onApprove} disabled={busy}>
              승인
            </button>
            <button className={cx(ui.btn, ui.outline, ui.sm)} onClick={() => onDialog({ kind: 'reject', user: u })} disabled={busy}>
              거절
            </button>
          </>
        )}
        {u.state === 'suspended' && (
          <button className={cx(ui.btn, ui.outline, ui.sm)} onClick={onUnsuspend} disabled={busy}>
            정지 풀기
          </button>
        )}
        <button ref={ref} className={ui.iconBtn} aria-label={`${u.name} 관리`} aria-haspopup="menu" aria-expanded={menu.open} onClick={menu.toggle}>
          <Icon name="more" size={16} />
        </button>
        <Popover anchor={ref} open={menu.open} onClose={menu.close} align="end" width={240}>
          <div role="menu" aria-label={`${u.name} 관리`}>
            {u.state !== 'suspended' && (
              <button role="menuitem" className={ui.menuItem} onClick={pick(() => onDialog({ kind: 'reset', user: u }))}>
                <Icon name="key" size={16} /> 비밀번호 재설정 링크
              </button>
            )}
            {u.state === 'unverified' && (
              <button role="menuitem" className={ui.menuItem} onClick={pick(onSkipVerification)}>
                <Icon name="mail" size={16} /> 메일 확인 없이 허용
              </button>
            )}
            {u.state === 'active' && !u.admin && (
              <button role="menuitem" className={ui.menuItem} onClick={pick(() => onDialog({ kind: 'admin', user: u, admin: true }))}>
                <Icon name="shield" size={16} /> 운영자로 지정
              </button>
            )}
            {u.admin && (
              <button role="menuitem" className={ui.menuItem} onClick={pick(() => onDialog({ kind: 'admin', user: u, admin: false }))}>
                <Icon name="shield" size={16} /> 운영자에서 해제
              </button>
            )}
            {!me && !u.admin && (
              <>
                <div className={ui.menuSep} />
                {u.state === 'suspended' ? (
                  <button role="menuitem" className={ui.menuItem} onClick={pick(onUnsuspend)}>
                    <Icon name="undo" size={16} /> 정지 풀기
                  </button>
                ) : (
                  <button role="menuitem" className={ui.menuItem} onClick={pick(() => onDialog({ kind: 'suspend', user: u }))}>
                    <Icon name="lock" size={16} /> 정지
                  </button>
                )}
                <button role="menuitem" className={cx(ui.menuItem, s.menuDanger)} onClick={pick(() => onDialog({ kind: 'delete', user: u }))}>
                  <Icon name="trash" size={16} /> 계정 삭제
                </button>
              </>
            )}
          </div>
        </Popover>
      </div>
    </li>
  );
}

function AdminRoleDialog({
  state,
  onClose,
  onConfirm,
}: {
  state: { user: AdminUser; admin: boolean } | null;
  onClose: () => void;
  onConfirm: (u: AdminUser, admin: boolean) => void;
}) {
  if (!state) return null;
  const { user: u, admin } = state;
  return (
    <Modal
      open
      onClose={onClose}
      title={admin ? `${u.name}님을 운영자로 지정할까요?` : `${u.name}님을 운영자에서 해제할까요?`}
      width={440}
      footer={
        <>
          <button className={cx(ui.btn, ui.outline)} onClick={onClose}>
            취소
          </button>
          <button
            className={cx(ui.btn, admin ? ui.primary : ui.danger)}
            autoFocus
            onClick={() => {
              onConfirm(u, admin);
              onClose();
            }}
          >
            {admin ? '운영자로 지정' : '해제'}
          </button>
        </>
      }
    >
      <p className={s.dialogText}>
        {admin
          ? '운영자는 가입 방식과 서버 설정을 바꾸고, 계정을 승인·정지·삭제하고, 다른 운영자를 지정할 수 있어요. 다른 사람의 작업 내용은 운영자도 볼 수 없어요.'
          : '서버 관리 화면에 더 이상 들어올 수 없어요. 운영자는 최소 한 명 있어야 해요.'}
      </p>
    </Modal>
  );
}

/** A one-time link to set a new password, to copy and hand over (or mail, when the server can). */
function ResetLinkDialog({ user, onClose }: { user: AdminUser | null; onClose: () => void }) {
  const [url, setUrl] = useState<string | null>(null);
  const [mailed, setMailed] = useState(false);
  const [busy, setBusy] = useState<'link' | 'mail' | null>(null);
  const [mailOk, setMailOk] = useState(false);

  useEffect(() => {
    if (!user) {
      setUrl(null);
      setMailed(false);
      return;
    }
    api<{ available: boolean }>('GET', '/api/auth/password-reset')
      .then((r) => setMailOk(r.available))
      .catch(() => setMailOk(false));
  }, [user]);

  if (!user) return null;
  const make = async (mail: boolean) => {
    setBusy(mail ? 'mail' : 'link');
    try {
      const r = await api<{ url: string; mailed: boolean }>('POST', `/api/admin/users/${user.id}/reset-link`, { mail });
      setUrl(r.url);
      setMailed(r.mailed);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="비밀번호 재설정 링크"
      description={`${user.name}님(${user.email})이 새 비밀번호를 정할 수 있는 링크예요. 60분 동안 한 번만 쓸 수 있고, 쓰면 다른 기기에서 모두 로그아웃돼요.`}
      width={480}
      footer={
        url ? (
          <button className={cx(ui.btn, ui.primary)} onClick={onClose}>
            닫기
          </button>
        ) : (
          <>
            {mailOk && (
              <button className={cx(ui.btn, ui.outline)} onClick={() => void make(true)} disabled={!!busy}>
                {busy === 'mail' ? '보내는 중…' : '메일로 보내기'}
              </button>
            )}
            <button className={cx(ui.btn, ui.primary)} onClick={() => void make(false)} disabled={!!busy}>
              {busy === 'link' ? '만드는 중…' : '링크 만들기'}
            </button>
          </>
        )
      }
    >
      {url ? (
        <div className={s.dialogStack}>
          <p className={s.dialogText}>
            {mailed ? (
              <>
                <strong>{user.email}</strong>(으)로 보냈어요. 메일이 오지 않으면 아래 링크를 직접 전해 주세요.
              </>
            ) : (
              '본인에게만 전해 주세요. 이 링크를 가진 사람은 누구든 이 계정의 비밀번호를 바꿀 수 있어요.'
            )}
          </p>
          <CopyField value={url} label="재설정 링크" done="링크를 복사했어요" />
        </div>
      ) : (
        <p className={s.dialogText}>운영자는 비밀번호를 직접 정하거나 볼 수 없어요. 링크를 받은 사람이 정해요.</p>
      )}
    </Modal>
  );
}

function SuspendDialog({ user, onClose, onDone }: { user: AdminUser | null; onClose: () => void; onDone: (u: AdminUser) => void }) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => setNote(''), [user]);
  if (!user) return null;
  const submit = async () => {
    setBusy(true);
    try {
      const r = await api<{ user: AdminUser }>('POST', `/api/admin/users/${user.id}/suspend`, note.trim() ? { note: note.trim() } : {});
      onDone(r.user);
      onClose();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      onClose={onClose}
      title={`${user.name}님을 정지할까요?`}
      width={460}
      footer={
        <>
          <button className={cx(ui.btn, ui.outline)} onClick={onClose}>
            취소
          </button>
          <button className={cx(ui.btn, ui.danger)} onClick={() => void submit()} disabled={busy}>
            {busy ? '정지하는 중…' : '정지'}
          </button>
        </>
      }
    >
      <div className={s.dialogStack}>
        <ul className={s.dialogList}>
          <li>바로 로그아웃되고 다시 로그인할 수 없어요.</li>
          <li>API 토큰과 AI 연결(Claude, ChatGPT 등)이 끊겨요. 정지를 풀어도 다시 연결해야 해요.</li>
          <li>이 사람이 만든 받는 웹훅이 멈춰요.</li>
          <li>작업, 프로젝트, 조직 멤버 자리는 그대로 남아요.</li>
        </ul>
        <div className={ui.field}>
          <label className={ui.label} htmlFor="suspend-note">
            메모 <span className={s.muted}>(운영 기록에만 남아요)</span>
          </label>
          <input id="suspend-note" className={ui.input} value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} placeholder="예: 스팸 계정" />
        </div>
      </div>
    </Modal>
  );
}

function DeleteDialog({ user, onClose, onDone }: { user: AdminUser | null; onClose: () => void; onDone: (u: AdminUser) => void }) {
  const [preview, setPreview] = useState<AccountDeletionPreview | null>(null);
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setPreview(null);
    setConfirm('');
    setError(null);
    if (!user) return;
    api<AccountDeletionPreview>('GET', `/api/admin/users/${user.id}/deletion`)
      .then(setPreview)
      .catch((e) => setError((e as Error).message));
  }, [user]);

  if (!user) return null;
  const blocked = !!preview?.blockers.length;
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api('DELETE', `/api/admin/users/${user.id}`, { confirm });
      onDone(user);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={`${user.email} 계정을 삭제할까요?`}
      width={480}
      footer={
        <>
          <button className={cx(ui.btn, ui.outline)} onClick={onClose}>
            취소
          </button>
          <button
            className={cx(ui.btn, ui.danger)}
            onClick={() => void submit()}
            disabled={busy || blocked || !preview || confirm.trim().toLowerCase() !== user.email.toLowerCase()}
          >
            {busy ? '삭제하는 중…' : '영구 삭제'}
          </button>
        </>
      }
    >
      <div className={s.dialogStack}>
        {error && (
          <div className={ui.alert} data-tone="danger" role="alert">
            <div className={ui.alertDescription}>{error}</div>
          </div>
        )}
        {!preview ? (
          !error && <Spinner />
        ) : blocked ? (
          <p className={s.dialogText}>
            {preview.blockers.map((b) => `‘${b.name}’`).join(', ')}의 마지막 소유자라서 지금은 삭제할 수 없어요. 조직 안에서 다른 멤버를 소유자로 정해야 해요.
            소유자가 정지된 상태라면 먼저 조직 탭에서 소유자를 지정하세요.
          </p>
        ) : (
          <>
            <ul className={s.dialogList}>
              <li>
                개인 공간의 프로젝트 {preview.personal.projects}개, 작업 {preview.personal.tasks}개가 지워져요.
              </li>
              {preview.soloOrgs.length > 0 && <li>혼자 있는 조직 {preview.soloOrgs.map((o) => `‘${o.name}’`).join(', ')}도 지워져요.</li>}
              {preview.sharedOrgs > 0 && <li>다른 사람과 함께 쓰던 조직 {preview.sharedOrgs}곳에서는 빠지고, 만든 작업은 남아요.</li>}
              <li>되돌릴 수 없어요.</li>
            </ul>
            <div className={ui.field}>
              <label className={ui.label} htmlFor="delete-confirm">
                확인을 위해 <strong>{user.email}</strong>을 입력하세요
              </label>
              <input
                id="delete-confirm"
                className={ui.input}
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
