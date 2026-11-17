'use client';

import {
  activityKind,
  describeActivity,
  isWorkspaceAdmin,
  ROLE_LABEL_KO,
  viaLabelKo,
  type ActivityEntry,
  type Invite,
  type Member,
  type Team,
  type WorkspaceRole,
} from '@obelisk/core';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Icon, type IconName } from '@/components/Icon';
import {
  Avatar,
  Badge,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  ConfirmModal,
  isEnter,
  Modal,
  Popover,
  Skeleton,
  Switch,
  ui,
  useDisclosure,
} from '@/components/primitives';
import { EmptyState, Page, ViewHeader } from '@/components/View';
import { WorkspaceMark } from '@/components/WorkspaceSwitcher';
import { api } from '@/lib/api';
import { cx, relativeTime } from '@/lib/format';
import { refresh, switchWorkspace, useApp } from '@/lib/store';
import { toast } from '@/lib/toast';
import { SettingsNav } from '../SettingsNav';
import base from '../settings.module.css';
import s from './org.module.css';

type Tab = 'members' | 'teams' | 'activity' | 'general';
const TABS: { id: Tab; label: string; icon: IconName }[] = [
  { id: 'members', label: '멤버', icon: 'users' },
  { id: 'teams', label: '팀', icon: 'layers' },
  { id: 'activity', label: '활동', icon: 'activity' },
  { id: 'general', label: '일반', icon: 'settings' },
];

export default function OrgSettingsPage() {
  return (
    <Suspense fallback={null}>
      <OrgSettings />
    </Suspense>
  );
}

function OrgSettings() {
  const app = useApp();
  const router = useRouter();
  const params = useSearchParams();
  const tab = (TABS.find((t) => t.id === params.get('tab'))?.id ?? 'members') as Tab;
  const ws = app.workspace;
  const setTab = (t: Tab) => router.replace(`/settings/org${t === 'members' ? '' : `?tab=${t}`}`, { scroll: false });

  if (ws && ws.kind !== 'org') {
    return (
      <Page>
        <ViewHeader icon="building" title="조직 설정" description="지금은 개인 공간이 열려 있어요.">
          <SettingsNav />
        </ViewHeader>
        <EmptyState
          icon="building"
          title="조직을 열면 여기서 관리할 수 있어요"
          body="사이드바 왼쪽 위 공간 이름을 눌러 조직으로 전환하거나 새 조직을 만들어 보세요."
        />
      </Page>
    );
  }

  return (
    <Page>
      <ViewHeader
        icon="building"
        title={ws?.name ?? '조직'}
        description={
          ws ? `${ROLE_LABEL_KO[ws.role]}로 참여 중 · 멤버 ${app.members.length}명 · 팀 ${app.teams.length}개` : undefined
        }
      >
        <SettingsNav />
      </ViewHeader>

      <div className={cx(ui.tabs, s.tabs)} role="tablist" aria-label="조직 설정">
        {TABS.map((t) => (
          <button key={t.id} role="tab" className={ui.tab} aria-selected={tab === t.id} onClick={() => setTab(t.id)}>
            <Icon name={t.icon} size={15} />
            {t.label}
          </button>
        ))}
      </div>

      <div className={cx(base.stack, s.panel)} key={tab}>
        {tab === 'members' && <MembersTab openInvite={params.get('invite') === '1'} />}
        {tab === 'teams' && <TeamsTab />}
        {tab === 'activity' && <ActivityTab />}
        {tab === 'general' && <GeneralTab />}
      </div>
    </Page>
  );
}

/* ───────────────────────────── members & invites */

const ROLES: WorkspaceRole[] = ['owner', 'admin', 'member'];
const ROLE_HINT: Record<WorkspaceRole, string> = {
  owner: '모든 권한 · 조직 삭제',
  admin: '멤버·팀·모든 프로젝트 관리',
  member: '공유받은 프로젝트만',
};

function MembersTab({ openInvite }: { openInvite: boolean }) {
  const app = useApp();
  const router = useRouter();
  const ws = app.workspace;
  const admin = isWorkspaceAdmin(ws?.role);
  const owner = ws?.role === 'owner';
  const invite = useDisclosure(openInvite && admin);
  const [q, setQ] = useState('');
  const [remove, setRemove] = useState<Member | null>(null);
  const teamName = useMemo(() => new Map(app.teams.map((t) => [t.id, t.name])), [app.teams]);

  const list = app.members.filter((m) => {
    const ql = q.trim().toLowerCase();
    return !ql || m.name.toLowerCase().includes(ql) || m.email.toLowerCase().includes(ql);
  });

  const setRole = async (m: Member, role: WorkspaceRole) => {
    try {
      await api('PATCH', `/api/workspaces/${ws!.id}/members/${m.id}`, { role });
      await refresh();
      toast.success(`${m.name}님을 ${ROLE_LABEL_KO[role]}(으)로 바꿨어요`);
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const doRemove = async (m: Member) => {
    try {
      await api('DELETE', `/api/workspaces/${ws!.id}/members/${m.id}`);
      await refresh();
      toast.success(`${m.name}님을 조직에서 내보냈어요`);
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  return (
    <>
      <Card className={base.section}>
        <CardHeader className={admin ? s.headWrap : undefined}>
          <CardTitle>멤버 {app.members.length}명</CardTitle>
          <CardDescription>
            멤버는 공유받은 프로젝트만 볼 수 있어요. 소유자와 관리자는 모든 프로젝트를 관리하고 멤버·팀·초대 링크를 다뤄요.
          </CardDescription>
          {admin && (
            <div className={s.headAction}>
              <button className={cx(ui.btn, ui.primary, ui.sm)} onClick={() => invite.setOpen(true)}>
                <Icon name="userPlus" size={15} /> 멤버 초대
              </button>
            </div>
          )}
        </CardHeader>
        <CardContent className={s.flush}>
          {app.members.length > 6 && (
            <div className={s.search}>
              <Icon name="search" size={15} />
              <input placeholder="이름이나 이메일로 찾기" aria-label="멤버 찾기" value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
          )}
          <ul className={s.people}>
            {list.map((m) => {
              const me = m.id === app.user?.id;
              // Owners are changed only by owners; admins handle admins and members.
              const editable = admin && !(m.role === 'owner' && !owner);
              return (
                <li key={m.id} className={s.person}>
                  <Avatar name={m.name} className={s.personAvatar} />
                  <div className={s.personText}>
                    <span className={s.personName}>
                      {m.name}
                      {me && <span className={s.muted}> (나)</span>}
                    </span>
                    <span className={s.personMeta}>
                      {m.email} · {relativeTime(m.joinedAt).replace('사용 기록 없음', '')} 참여
                    </span>
                  </div>
                  <div className={s.personTeams}>
                    {m.teamIds.slice(0, 3).map((id) => (
                      <span key={id} className={ui.chip}>
                        {teamName.get(id)}
                      </span>
                    ))}
                    {m.teamIds.length > 3 && <span className={ui.chip}>+{m.teamIds.length - 3}</span>}
                  </div>
                  {editable ? (
                    <RoleSelect value={m.role} canOwner={owner} onChange={(r) => void setRole(m, r)} label={`${m.name} 역할`} />
                  ) : (
                    <span className={s.roleText} data-role={m.role}>
                      {m.role === 'owner' && <Icon name="crown" size={13} />}
                      {ROLE_LABEL_KO[m.role]}
                    </span>
                  )}
                  {(editable || me) && (
                    <button
                      className={cx(ui.iconBtn, s.removeBtn)}
                      aria-label={me ? '조직 나가기' : `${m.name} 내보내기`}
                      title={me ? '조직 나가기' : '내보내기'}
                      onClick={() => setRemove(m)}
                    >
                      <Icon name={me ? 'logout' : 'x'} size={15} />
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </CardContent>
      </Card>

      {admin && <InvitesCard onCreate={() => invite.setOpen(true)} />}

      <InviteModal open={invite.open} onClose={invite.close} />
      <ConfirmModal
        open={!!remove}
        onClose={() => setRemove(null)}
        title={remove?.id === app.user?.id ? '조직을 나갈까요?' : `${remove?.name}님을 내보낼까요?`}
        confirmLabel={remove?.id === app.user?.id ? '나가기' : '내보내기'}
        body={
          remove?.id === app.user?.id
            ? '이 조직의 프로젝트와 작업에 더 이상 접근할 수 없어요. 다시 들어오려면 초대 링크가 필요해요.'
            : '이 조직의 프로젝트 권한과 팀 소속이 사라지고, 맡고 있던 작업은 담당자 없음이 돼요. 만든 작업은 그대로 남아요.'
        }
        onConfirm={async () => {
          const m = remove!;
          if (m.id === app.user?.id) {
            try {
              await api('DELETE', `/api/workspaces/${ws!.id}/members/${m.id}`);
              toast.success(`${ws!.name}에서 나왔어요`);
              const personal = app.workspaces.find((w) => w.kind === 'personal');
              router.push('/');
              if (personal) await switchWorkspace(personal.id);
            } catch (e) {
              toast.error((e as Error).message);
            }
          } else void doRemove(m);
        }}
      />
    </>
  );
}

function RoleSelect({
  value,
  canOwner,
  onChange,
  label,
}: {
  value: WorkspaceRole;
  canOwner: boolean;
  onChange: (r: WorkspaceRole) => void;
  label: string;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const d = useDisclosure();
  return (
    <>
      <button ref={ref} className={s.roleBtn} data-role={value} aria-haspopup="menu" aria-expanded={d.open} aria-label={label} onClick={d.toggle}>
        {value === 'owner' && <Icon name="crown" size={13} />}
        {ROLE_LABEL_KO[value]}
        <Icon name="chevronDown" size={13} className={s.roleChev} />
      </button>
      <Popover anchor={ref} open={d.open} onClose={d.close} align="end" width={250}>
        <div role="menu" aria-label={label}>
          {ROLES.filter((r) => r !== 'owner' || canOwner).map((r) => (
            <button
              key={r}
              role="menuitemradio"
              aria-checked={r === value}
              className={cx(ui.menuItem, s.roleItem)}
              data-selected={r === value}
              onClick={() => {
                d.close();
                if (r !== value) onChange(r);
              }}
            >
              <span className={s.roleItemText}>
                <span>{ROLE_LABEL_KO[r]}</span>
                <span className={s.roleItemHint}>{ROLE_HINT[r]}</span>
              </span>
              {r === value && <Icon name="check" size={14} />}
            </button>
          ))}
        </div>
      </Popover>
    </>
  );
}

function InvitesCard({ onCreate }: { onCreate: () => void }) {
  const { workspace } = useApp();
  const [invites, setInvites] = useState<Invite[] | null>(null);
  const load = useCallback(async () => {
    if (!workspace) return;
    try {
      const r = await api<{ invites: Invite[] }>('GET', `/api/workspaces/${workspace.id}/invites`);
      setInvites(r.invites);
    } catch {
      setInvites([]);
    }
  }, [workspace]);
  useEffect(() => {
    void load();
    const on = () => void load();
    window.addEventListener('obelisk:invites', on);
    return () => window.removeEventListener('obelisk:invites', on);
  }, [load]);

  const revoke = async (inv: Invite) => {
    try {
      await api('DELETE', `/api/workspaces/${workspace!.id}/invites/${inv.id}`);
      setInvites((l) => l?.filter((x) => x.id !== inv.id) ?? null);
      toast.success('초대 링크를 취소했어요. 이미 들어온 사람은 그대로예요.');
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  return (
    <Card className={base.section}>
      <CardHeader className={s.headWrap}>
        <CardTitle>초대 링크</CardTitle>
        <CardDescription>
          링크를 받은 사람은 가입하거나 로그인한 뒤 바로 들어와요. 서버가 새 가입을 막아 두었어도 초대 링크로는 가입할 수 있어요.
        </CardDescription>
        <div className={s.headAction}>
          <button className={cx(ui.btn, ui.outline, ui.sm)} onClick={onCreate}>
            <Icon name="link" size={15} /> 새 링크
          </button>
        </div>
      </CardHeader>
      <CardContent className={s.flush}>
        {invites === null ? (
          <div className={s.pad}>
            <Skeleton height={14} width="60%" />
          </div>
        ) : invites.length === 0 ? (
          <p className={s.emptyLine}>사용할 수 있는 초대 링크가 없어요.</p>
        ) : (
          <ul className={s.people}>
            {invites.map((inv) => (
              <li key={inv.id} className={s.person}>
                <span className={s.linkMark}>
                  <Icon name="link" size={15} />
                </span>
                <div className={s.personText}>
                  <span className={s.personName}>
                    <code className={s.hint}>…{inv.hint}</code> · {ROLE_LABEL_KO[inv.role]}로 초대
                  </span>
                  <span className={s.personMeta}>
                    {inv.maxUses ? `${inv.uses}/${inv.maxUses}회 사용` : `${inv.uses}회 사용`} ·{' '}
                    {inv.expiresAt ? `${new Date(inv.expiresAt).toLocaleDateString('ko-KR', { month: 'long', day: 'numeric' })}까지` : '만료 없음'}
                    {inv.createdBy ? ` · ${inv.createdBy}` : ''}
                  </span>
                </div>
                <button className={cx(ui.btn, ui.ghost, ui.sm)} onClick={() => void revoke(inv)}>
                  취소
                </button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

const EXPIRY = [
  { v: 1, label: '1일' },
  { v: 7, label: '7일' },
  { v: 30, label: '30일' },
  { v: null, label: '만료 없음' },
] as const;
const USES = [
  { v: 1, label: '1회' },
  { v: 5, label: '5회' },
  { v: 25, label: '25회' },
  { v: null, label: '제한 없음' },
] as const;

function InviteModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { workspace } = useApp();
  const [role, setRole] = useState<'member' | 'admin'>('member');
  const [expires, setExpires] = useState<number | null>(7);
  const [uses, setUses] = useState<number | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) setUrl(null);
  }, [open]);

  const create = async () => {
    setBusy(true);
    try {
      const r = await api<{ url: string }>('POST', `/api/workspaces/${workspace!.id}/invites`, {
        role,
        expiresInDays: expires,
        maxUses: uses,
      });
      setUrl(r.url);
      window.dispatchEvent(new Event('obelisk:invites'));
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const copy = () => {
    if (!url) return;
    void navigator.clipboard?.writeText(url);
    toast.success('초대 링크를 복사했어요');
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      width={500}
      icon={<Icon name="userPlus" size={18} />}
      title={url ? '초대 링크가 준비됐어요' : `${workspace?.name ?? '조직'}에 초대`}
      description={
        url
          ? '이 링크는 지금 한 번만 보여드려요. 메신저나 메일로 전달하세요.'
          : '메일 없이 링크로 초대해요. 들어온 사람은 공유받은 프로젝트만 볼 수 있어요.'
      }
      footer={
        url ? (
          <>
            <button className={cx(ui.btn, ui.outline)} onClick={() => setUrl(null)}>
              링크 하나 더
            </button>
            <button className={cx(ui.btn, ui.primary)} onClick={onClose}>
              완료
            </button>
          </>
        ) : (
          <>
            <button className={cx(ui.btn, ui.outline)} onClick={onClose}>
              취소
            </button>
            <button className={cx(ui.btn, ui.primary)} disabled={busy} onClick={() => void create()}>
              링크 만들기
            </button>
          </>
        )
      }
    >
      {url ? (
        <div className={s.linkBox}>
          <code className={s.linkUrl}>{url}</code>
          <button className={cx(ui.btn, ui.primary, ui.sm)} onClick={copy} autoFocus>
            <Icon name="copy" size={14} /> 복사
          </button>
        </div>
      ) : (
        <div className={s.inviteForm}>
          <Choice label="역할" value={role} onChange={setRole} options={[{ v: 'member', label: '멤버' }, { v: 'admin', label: '관리자' }]} />
          <p className={cx(ui.help, s.choiceHelp)}>
            {role === 'admin' ? '관리자는 모든 프로젝트와 멤버를 관리할 수 있어요.' : '멤버는 공유받은 프로젝트만 볼 수 있어요.'}
          </p>
          <Choice label="만료" value={expires} onChange={setExpires} options={EXPIRY} />
          <Choice label="사용 횟수" value={uses} onChange={setUses} options={USES} />
        </div>
      )}
    </Modal>
  );
}

function Choice<T extends string | number | null>({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: T;
  onChange: (v: T) => void;
  options: readonly { v: T; label: string }[];
}) {
  return (
    <div className={s.choice}>
      <span className={ui.label}>{label}</span>
      <div className={ui.segmented} data-full="true" role="group" aria-label={label}>
        {options.map((o) => (
          <button key={String(o.v)} className={ui.segment} aria-pressed={o.v === value} onClick={() => onChange(o.v)}>
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/* ───────────────────────────── teams */

function TeamsTab() {
  const app = useApp();
  const admin = isWorkspaceAdmin(app.workspace?.role);
  const [editing, setEditing] = useState<Team | 'new' | null>(null);
  const [del, setDel] = useState<Team | null>(null);

  return (
    <>
      <Card className={base.section}>
        <CardHeader className={admin ? s.headWrap : undefined}>
          <CardTitle>팀 {app.teams.length}개</CardTitle>
          <CardDescription>
            팀에 프로젝트를 공유하면 팀원 모두가 같은 권한을 받아요. 사람이 바뀌어도 팀 구성만 고치면 돼요.
          </CardDescription>
          {admin && (
            <div className={s.headAction}>
              <button className={cx(ui.btn, ui.primary, ui.sm)} onClick={() => setEditing('new')}>
                <Icon name="plus" size={15} /> 새 팀
              </button>
            </div>
          )}
        </CardHeader>
        <CardContent className={s.flush}>
          {app.teams.length === 0 ? (
            <p className={s.emptyLine}>{admin ? '아직 팀이 없어요. ‘디자인’, ‘개발’처럼 자주 함께 공유받는 사람들을 묶어 보세요.' : '아직 팀이 없어요.'}</p>
          ) : (
            <ul className={s.people}>
              {app.teams.map((t) => {
                const members = t.memberIds.map((id) => app.members.find((m) => m.id === id)).filter(Boolean) as Member[];
                return (
                  <li key={t.id} className={s.person}>
                    <span className={s.teamMark}>
                      <Icon name="users" size={15} />
                    </span>
                    <div className={s.personText}>
                      <span className={s.personName}>{t.name}</span>
                      <span className={s.personMeta}>
                        {members.length ? members.map((m) => m.name).join(', ') : '팀원 없음'}
                      </span>
                    </div>
                    <div className={s.stack}>
                      {members.slice(0, 4).map((m) => (
                        <Avatar key={m.id} name={m.name} size="sm" className={s.stackAvatar} />
                      ))}
                      {members.length > 4 && <span className={s.stackMore}>+{members.length - 4}</span>}
                    </div>
                    {admin && (
                      <>
                        <button className={cx(ui.btn, ui.ghost, ui.sm)} onClick={() => setEditing(t)}>
                          편집
                        </button>
                        <button className={cx(ui.iconBtn, s.removeBtn)} aria-label={`${t.name} 팀 삭제`} onClick={() => setDel(t)}>
                          <Icon name="trash" size={15} />
                        </button>
                      </>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>
      <TeamModal team={editing} onClose={() => setEditing(null)} />
      <ConfirmModal
        open={!!del}
        onClose={() => setDel(null)}
        title={`‘${del?.name}’ 팀을 삭제할까요?`}
        body="이 팀을 통해 받은 프로젝트 권한이 사라져요. 팀원 개인에게 준 권한은 그대로예요."
        onConfirm={async () => {
          try {
            await api('DELETE', `/api/workspaces/${app.workspace!.id}/teams/${del!.id}`);
            await refresh();
            toast.success('팀을 삭제했어요');
          } catch (e) {
            toast.error((e as Error).message);
          }
        }}
      />
    </>
  );
}

function TeamModal({ team, onClose }: { team: Team | 'new' | null; onClose: () => void }) {
  const app = useApp();
  const [name, setName] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const isNew = team === 'new';

  useEffect(() => {
    if (!team) return;
    setName(team === 'new' ? '' : team.name);
    setPicked(new Set(team === 'new' ? [] : team.memberIds));
    setQ('');
  }, [team]);

  const ql = q.trim().toLowerCase();
  const list = app.members.filter((m) => !ql || m.name.toLowerCase().includes(ql) || m.email.toLowerCase().includes(ql));

  const save = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      const body = { name: name.trim(), memberIds: [...picked] };
      if (isNew) await api('POST', `/api/workspaces/${app.workspace!.id}/teams`, body);
      else await api('PATCH', `/api/workspaces/${app.workspace!.id}/teams/${(team as Team).id}`, body);
      await refresh();
      toast.success(isNew ? `‘${body.name}’ 팀을 만들었어요` : '팀을 저장했어요');
      onClose();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={!!team}
      onClose={onClose}
      width={480}
      icon={<Icon name="users" size={18} />}
      title={isNew ? '새 팀' : '팀 편집'}
      footer={
        <>
          <span className={s.footCount}>{picked.size}명 선택</span>
          <button className={cx(ui.btn, ui.outline)} onClick={onClose}>
            취소
          </button>
          <button className={cx(ui.btn, ui.primary)} disabled={!name.trim() || busy} onClick={() => void save()}>
            {isNew ? '만들기' : '저장'}
          </button>
        </>
      }
    >
      <div className={s.teamForm}>
        <div className={ui.field}>
          <label className={ui.label} htmlFor="team-name">
            팀 이름
          </label>
          <input
            id="team-name"
            className={ui.input}
            autoFocus
            maxLength={60}
            placeholder="예: 디자인, 백엔드, 마케팅"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => isEnter(e) && void save()}
          />
        </div>
        <div className={ui.field}>
          <span className={ui.label}>팀원</span>
          <div className={s.search} data-boxed="true">
            <Icon name="search" size={15} />
            <input placeholder="이름이나 이메일로 찾기" aria-label="팀원 찾기" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <ul className={s.pickList}>
            {list.map((m) => {
              const on = picked.has(m.id);
              return (
                <li key={m.id}>
                  <label className={s.pick} data-on={on}>
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={() =>
                        setPicked((p) => {
                          const n = new Set(p);
                          if (n.has(m.id)) n.delete(m.id);
                          else n.add(m.id);
                          return n;
                        })
                      }
                    />
                    <span className={s.pickBox} aria-hidden="true">
                      <Icon name="check" size={12} strokeWidth={3} />
                    </span>
                    <Avatar name={m.name} size="sm" />
                    <span className={s.personText}>
                      <span className={s.personName}>{m.name}</span>
                      <span className={s.personMeta}>{m.email}</span>
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    </Modal>
  );
}

/* ───────────────────────────── activity log */

const KIND_FILTERS: { id: 'all' | 'task' | 'project' | 'people'; label: string }[] = [
  { id: 'all', label: '전체' },
  { id: 'task', label: '작업' },
  { id: 'project', label: '프로젝트·공유' },
  { id: 'people', label: '멤버·팀' },
];

const KIND_ICON: Record<ReturnType<typeof activityKind>, IconName> = {
  task: 'checkCircle',
  project: 'folder',
  member: 'user',
  team: 'users',
  invite: 'link',
  workspace: 'building',
};

function ActivityTab() {
  const app = useApp();
  const admin = isWorkspaceAdmin(app.workspace?.role);
  const [entries, setEntries] = useState<ActivityEntry[] | null>(null);
  const [more, setMore] = useState(true);
  const [kind, setKind] = useState<(typeof KIND_FILTERS)[number]['id']>('all');
  const [actor, setActor] = useState<string>('');
  const [loadingMore, setLoadingMore] = useState(false);

  const fetchPage = useCallback(
    async (before?: string) => {
      const qs = new URLSearchParams({ limit: '60' });
      if (before) qs.set('before', before);
      if (actor) qs.set('actorId', actor);
      const r = await api<{ activity: ActivityEntry[] }>('GET', `/api/workspaces/${app.workspace!.id}/activity?${qs}`);
      return r.activity;
    },
    [app.workspace, actor],
  );

  useEffect(() => {
    if (!app.workspace) return;
    let alive = true;
    setEntries(null);
    fetchPage()
      .then((list) => {
        if (!alive) return;
        setEntries(list);
        setMore(list.length === 60);
      })
      .catch((e) => toast.error((e as Error).message));
    return () => {
      alive = false;
    };
  }, [fetchPage, app.workspace]);

  const loadMore = async () => {
    if (!entries?.length) return;
    setLoadingMore(true);
    try {
      const list = await fetchPage(entries.at(-1)!.createdAt);
      setEntries([...entries, ...list]);
      setMore(list.length === 60);
    } finally {
      setLoadingMore(false);
    }
  };

  const shown = (entries ?? []).filter((e) => {
    const k = activityKind(e.action);
    if (kind === 'all') return true;
    if (kind === 'people') return k === 'member' || k === 'team' || k === 'invite' || k === 'workspace';
    return k === kind;
  });

  // Group by local day for a calmer feed.
  const days = useMemo(() => {
    const out: { day: string; items: ActivityEntry[] }[] = [];
    for (const e of shown) {
      const day = new Date(e.createdAt).toLocaleDateString('ko-KR', { month: 'long', day: 'numeric', weekday: 'short' });
      const last = out.at(-1);
      if (last?.day === day) last.items.push(e);
      else out.push({ day, items: [e] });
    }
    return out;
  }, [shown]);

  const project = (id: string | null) => (id ? app.projects.find((p) => p.id === id) : undefined);

  return (
    <Card className={base.section}>
      <CardHeader>
        <CardTitle>활동</CardTitle>
        <CardDescription>
          {admin
            ? '조직에서 일어난 모든 변경이에요. AI 앱이나 API 토큰으로 한 일도 표시돼요.'
            : '볼 수 있는 프로젝트와 내 작업에서 일어난 변경이에요. 멤버·팀 관련 기록은 관리자만 볼 수 있어요.'}
        </CardDescription>
      </CardHeader>
      <CardContent className={s.flush}>
        <div className={s.filters}>
          <div className={ui.segmented} data-size="sm" role="group" aria-label="종류">
            {KIND_FILTERS.filter((f) => admin || f.id !== 'people').map((f) => (
              <button key={f.id} className={ui.segment} aria-pressed={kind === f.id} onClick={() => setKind(f.id)}>
                {f.label}
              </button>
            ))}
          </div>
          <select className={cx(ui.input, s.actorSelect)} value={actor} onChange={(e) => setActor(e.target.value)} aria-label="사람">
            <option value="">모든 사람</option>
            {app.members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </div>

        {entries === null ? (
          <div className={s.pad}>
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} height={14} width={`${70 - i * 10}%`} style={{ marginBottom: 14 }} />
            ))}
          </div>
        ) : shown.length === 0 ? (
          <p className={s.emptyLine}>기록된 활동이 없어요.</p>
        ) : (
          <div className={s.feed}>
            {days.map((d) => (
              <section key={d.day} className={s.day}>
                <h4 className={s.dayLabel}>{d.day}</h4>
                <ol className={s.entries}>
                  {d.items.map((e) => {
                    const via = viaLabelKo(e.via, e.client);
                    const p = project(e.projectId);
                    const k = activityKind(e.action);
                    return (
                      <li key={e.id} className={s.entry}>
                        <span className={s.entryIcon} data-kind={k}>
                          <Icon name={KIND_ICON[k]} size={13} />
                        </span>
                        <div className={s.entryBody}>
                          <p className={s.entryText}>
                            <strong>{e.actor.name}</strong>
                            {e.subject && !e.action.startsWith('workspace.') && (
                              <>
                                {' · '}
                                <span className={s.subject}>{e.subject}</span>
                              </>
                            )}
                            <span className={s.what}> — {describeActivity(e)}</span>
                          </p>
                          <p className={s.entryMeta}>
                            <time dateTime={e.createdAt}>
                              {new Date(e.createdAt).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}
                            </time>
                            {p && k === 'task' && (
                              <span className={s.entryProject}>
                                <span className={ui.dot} style={{ background: `var(--c-${p.color})` }} /> {p.name}
                              </span>
                            )}
                            {via && (
                              <Badge tone="outline" className={s.viaBadge}>
                                <Icon name={e.via === 'oauth' ? 'sparkle' : e.via === 'webhook' ? 'link' : 'key'} size={11} /> {via}
                              </Badge>
                            )}
                          </p>
                        </div>
                      </li>
                    );
                  })}
                </ol>
              </section>
            ))}
            {more && (
              <div className={s.moreRow}>
                <button className={cx(ui.btn, ui.outline, ui.sm)} disabled={loadingMore} onClick={() => void loadMore()}>
                  {loadingMore ? '불러오는 중…' : '이전 기록 더 보기'}
                </button>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/* ───────────────────────────── general */

function GeneralTab() {
  const app = useApp();
  const router = useRouter();
  const ws = app.workspace!;
  const admin = isWorkspaceAdmin(ws.role);
  const owner = ws.role === 'owner';
  const [name, setName] = useState(ws.name);
  const del = useDisclosure();
  const leave = useDisclosure();
  const [confirm, setConfirm] = useState('');

  useEffect(() => setName(ws.name), [ws.name]);

  const patch = async (body: { name?: string; membersCanCreateProjects?: boolean }, done: string) => {
    try {
      await api('PATCH', `/api/workspaces/${ws.id}`, body);
      await refresh();
      toast.success(done);
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const personal = app.workspaces.find((w) => w.kind === 'personal');

  return (
    <>
      <Card className={base.section}>
        <CardHeader>
          <CardTitle>조직 정보</CardTitle>
          <CardDescription>사이드바와 초대 화면에 보이는 이름이에요.</CardDescription>
        </CardHeader>
        <CardContent className={s.orgInfo}>
          <WorkspaceMark ws={{ kind: 'org', name: name || ws.name }} size="lg" />
          <div className={cx(ui.field, s.grow)}>
            <label className={ui.label} htmlFor="org-name">
              이름
            </label>
            <input id="org-name" className={ui.input} value={name} disabled={!admin} maxLength={80} onChange={(e) => setName(e.target.value)} />
          </div>
        </CardContent>
        {admin && (
          <CardFooter className={base.footer}>
            <span className={base.footerNote}>{name.trim() !== ws.name ? '저장하지 않은 변경 사항이 있어요' : ' '}</span>
            <button
              className={cx(ui.btn, ui.primary)}
              disabled={!name.trim() || name.trim() === ws.name}
              onClick={() => void patch({ name: name.trim() }, '조직 이름을 바꿨어요')}
            >
              저장
            </button>
          </CardFooter>
        )}
      </Card>

      <Card className={base.section}>
        <CardHeader>
          <CardTitle>권한 기본값</CardTitle>
          <CardDescription>새 프로젝트는 항상 비공개로 시작해요. 만든 사람이 관리 권한을 갖고 필요한 사람에게 공유해요.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className={base.row}>
            <div className={base.rowText}>
              <p className={base.rowTitle}>멤버도 프로젝트를 만들 수 있어요</p>
              <p className={base.rowDesc}>끄면 소유자와 관리자만 새 프로젝트를 만들 수 있어요.</p>
            </div>
            <Switch
              checked={ws.membersCanCreateProjects}
              label="멤버 프로젝트 생성 허용"
              onChange={(v) =>
                admin
                  ? void patch({ membersCanCreateProjects: v }, v ? '멤버도 프로젝트를 만들 수 있어요' : '이제 관리자만 프로젝트를 만들 수 있어요')
                  : toast.error('관리자만 바꿀 수 있어요')
              }
            />
          </div>
        </CardContent>
      </Card>

      <Card className={base.section}>
        <CardHeader>
          <CardTitle>조직 나가기 · 삭제</CardTitle>
        </CardHeader>
        <CardContent className={s.dangerStack}>
          <div className={base.dangerRow}>
            <div className={base.rowText}>
              <p className={base.rowTitle}>조직 나가기</p>
              <p className={base.rowDesc}>이 조직의 프로젝트에 더 이상 접근할 수 없어요. 마지막 소유자는 나갈 수 없어요.</p>
            </div>
            <button className={cx(ui.btn, ui.outline)} onClick={() => leave.setOpen(true)}>
              <Icon name="logout" size={15} /> 나가기
            </button>
          </div>
          {owner && (
            <div className={base.dangerRow}>
              <div className={base.rowText}>
                <p className={base.rowTitle}>조직 삭제</p>
                <p className={base.rowDesc}>모든 프로젝트·작업·활동 기록이 영구히 지워져요. 되돌릴 수 없어요.</p>
              </div>
              <button className={cx(ui.btn, ui.danger)} onClick={() => (setConfirm(''), del.setOpen(true))}>
                <Icon name="trash" size={15} /> 조직 삭제
              </button>
            </div>
          )}
        </CardContent>
      </Card>

      <ConfirmModal
        open={leave.open}
        onClose={leave.close}
        title="조직을 나갈까요?"
        confirmLabel="나가기"
        body="이 조직의 프로젝트와 작업에 더 이상 접근할 수 없어요. 다시 들어오려면 초대 링크가 필요해요."
        onConfirm={async () => {
          try {
            await api('DELETE', `/api/workspaces/${ws.id}/members/${app.user!.id}`);
            toast.success(`${ws.name}에서 나왔어요`);
            router.push('/');
            if (personal) await switchWorkspace(personal.id);
          } catch (e) {
            toast.error((e as Error).message);
          }
        }}
      />
      <Modal
        open={del.open}
        onClose={del.close}
        width={460}
        title="조직을 삭제할까요?"
        description="프로젝트, 작업, 팀, 초대 링크, 활동 기록이 모두 영구히 삭제되고 모든 멤버가 접근을 잃어요."
        footer={
          <>
            <button className={cx(ui.btn, ui.outline)} onClick={del.close}>
              취소
            </button>
            <button
              className={cx(ui.btn, ui.danger)}
              disabled={confirm.trim() !== ws.name}
              onClick={async () => {
                try {
                  await api('DELETE', `/api/workspaces/${ws.id}`, { confirm: confirm.trim() });
                  del.close();
                  toast.success(`${ws.name} 조직을 삭제했어요`);
                  router.push('/');
                  if (personal) await switchWorkspace(personal.id);
                } catch (e) {
                  toast.error((e as Error).message);
                }
              }}
            >
              영구 삭제
            </button>
          </>
        }
      >
        <div className={ui.field}>
          <label className={ui.label} htmlFor="confirm-name">
            확인을 위해 <b>{ws.name}</b>을(를) 입력하세요
          </label>
          <input id="confirm-name" className={ui.input} autoFocus value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </div>
      </Modal>
    </>
  );
}
