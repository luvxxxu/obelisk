'use client';

import {
  isWorkspaceAdmin,
  LEVEL_LABEL_KO,
  ROLE_LABEL_KO,
  type AccessLevel,
  type MemberAccess,
  type Project,
  type ProjectAccessInfo,
  type UpdateProjectAccessInput,
} from '@obelisk/core';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { cx } from '@/lib/format';
import { refresh, useApp } from '@/lib/store';
import { toast } from '@/lib/toast';
import { Icon } from './Icon';
import { Avatar, isEnter, Modal, Spinner, ui } from './primitives';
import s from './ShareDialog.module.css';

const LEVELS: AccessLevel[] = ['view', 'edit', 'manage'];
const EVERYONE: MemberAccess[] = ['none', 'view', 'edit'];

const LEVEL_HINT: Record<AccessLevel | 'none', string> = {
  none: '초대한 사람만',
  view: '작업을 볼 수 있어요',
  edit: '작업을 추가·수정·삭제할 수 있어요',
  manage: '공유·이름·보관·삭제까지',
};

type Candidate = { kind: 'member' | 'team'; id: string; name: string; meta: string };

/**
 * Notion-style share dialog for an organization project: what every member gets, plus
 * grants to people and teams. Changes apply immediately. Without "manage" it is read-only,
 * so anyone who can see a project can also see who else can.
 */
export function ShareDialog({ project, open, onClose }: { project: Project; open: boolean; onClose: () => void }) {
  const app = useApp();
  const [info, setInfo] = useState<ProjectAccessInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState('');
  const [addLevel, setAddLevel] = useState<AccessLevel>('edit');
  const inputRef = useRef<HTMLInputElement>(null);
  const canManage = project.access === 'manage';
  const orgName = app.workspace?.name ?? '조직';

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setInfo(null);
    api<{ access: ProjectAccessInfo }>('GET', `/api/projects/${project.id}/access`)
      .then((r) => alive && setInfo(r.access))
      .catch((e) => {
        toast.error((e as Error).message);
        onClose();
      });
    return () => {
      alive = false;
    };
  }, [open, project.id, onClose]);

  const apply = async (patch: UpdateProjectAccessInput, done?: string) => {
    setBusy(true);
    try {
      const r = await api<{ access: ProjectAccessInfo }>('PUT', `/api/projects/${project.id}/access`, patch);
      setInfo(r.access);
      void refresh();
      if (done) toast.success(done);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const admins = app.members.filter((m) => isWorkspaceAdmin(m.role));
  const memberGrants = useMemo(
    () =>
      (info?.members ?? [])
        .map((g) => ({ ...g, member: app.members.find((m) => m.id === g.userId) }))
        .filter((g) => g.member && !isWorkspaceAdmin(g.member.role)),
    [info, app.members],
  );
  const teamGrants = useMemo(
    () => (info?.teams ?? []).map((g) => ({ ...g, team: app.teams.find((t) => t.id === g.teamId) })).filter((g) => g.team),
    [info, app.teams],
  );
  const seeing = info ? info.effective.filter((e) => e.level).length : 0;

  const candidates: Candidate[] = useMemo(() => {
    if (!info) return [];
    const ql = q.trim().toLowerCase();
    const granted = new Set([...info.members.map((m) => m.userId), ...info.teams.map((t) => t.teamId)]);
    const teams = app.teams
      .filter((t) => !granted.has(t.id))
      .map((t) => ({ kind: 'team' as const, id: t.id, name: t.name, meta: `팀 · ${t.memberIds.length}명` }));
    const people = app.members
      .filter((m) => !granted.has(m.id) && !isWorkspaceAdmin(m.role))
      .map((m) => ({ kind: 'member' as const, id: m.id, name: m.name, meta: m.email }));
    return [...teams, ...people].filter((c) => !ql || c.name.toLowerCase().includes(ql) || c.meta.toLowerCase().includes(ql)).slice(0, 8);
  }, [info, q, app.teams, app.members]);

  const add = (c: Candidate) => {
    setQ('');
    void apply(
      c.kind === 'team' ? { teams: [{ teamId: c.id, level: addLevel }] } : { members: [{ userId: c.id, level: addLevel }] },
      `${c.name}${c.kind === 'team' ? ' 팀' : '님'}에게 ${LEVEL_LABEL_KO[addLevel]} 권한을 줬어요`,
    );
    inputRef.current?.focus();
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      width={540}
      icon={<Icon name="users" size={18} />}
      title={`‘${project.name}’ 공유`}
      description={
        canManage
          ? '바꾸면 바로 적용돼요. 소유자와 관리자는 언제나 모든 프로젝트를 관리할 수 있어요.'
          : '이 프로젝트에 누가 접근할 수 있는지 볼 수 있어요. 바꾸려면 관리 권한이 필요해요.'
      }
      footer={
        <>
          <span className={s.footNote}>
            {info ? `멤버 ${info.effective.length}명 중 ${seeing}명이 볼 수 있어요` : ' '}
          </span>
          <button
            className={cx(ui.btn, ui.outline)}
            onClick={() => {
              void navigator.clipboard?.writeText(`${location.origin}/projects/${project.id}`);
              toast.show('프로젝트 링크를 복사했어요');
            }}
          >
            <Icon name="link" size={15} /> 링크 복사
          </button>
          <button className={cx(ui.btn, ui.primary)} onClick={onClose}>
            완료
          </button>
        </>
      }
    >
      {!info ? (
        <div className={s.loading}>
          <Spinner />
        </div>
      ) : (
        <div className={s.body} data-busy={busy}>
          {canManage && (
            <div className={s.adder}>
              <div className={s.adderField}>
                <Icon name="userPlus" size={16} className={s.adderIcon} />
                <input
                  ref={inputRef}
                  className={s.adderInput}
                  placeholder="멤버나 팀 이름으로 추가"
                  aria-label="멤버나 팀 추가"
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  onKeyDown={(e) => {
                    if (isEnter(e) && candidates[0]) add(candidates[0]);
                  }}
                />
                <LevelSelect value={addLevel} onChange={(v) => setAddLevel(v as AccessLevel)} options={LEVELS} label="추가할 권한" />
              </div>
              {q.trim() !== '' && (
                <div className={s.suggest} role="listbox" aria-label="추가할 수 있는 멤버와 팀">
                  {candidates.length ? (
                    candidates.map((c, i) => (
                      <button key={c.id} className={ui.menuItem} data-active={i === 0} role="option" aria-selected={i === 0} onClick={() => add(c)}>
                        {c.kind === 'team' ? (
                          <span className={s.teamMark}>
                            <Icon name="users" size={13} />
                          </span>
                        ) : (
                          <Avatar name={c.name} size="sm" className={s.avatar} />
                        )}
                        <span className={s.who}>
                          <span className={ui.truncate}>{c.name}</span>
                          <span className={s.whoMeta}>{c.meta}</span>
                        </span>
                        <span className={s.addHint}>{LEVEL_LABEL_KO[addLevel]}로 추가</span>
                      </button>
                    ))
                  ) : (
                    <div className={s.none}>추가할 수 있는 멤버나 팀이 없어요</div>
                  )}
                </div>
              )}
            </div>
          )}

          <ul className={s.list}>
            <li className={s.row}>
              <span className={s.orgMark}>
                <Icon name="building" size={15} />
              </span>
              <span className={s.who}>
                <span className={s.whoName}>{orgName}의 모든 멤버</span>
                <span className={s.whoMeta}>{LEVEL_HINT[info.memberAccess]}</span>
              </span>
              <LevelSelect
                value={info.memberAccess}
                options={EVERYONE}
                label="조직 전체 권한"
                disabled={!canManage}
                onChange={(v) =>
                  void apply(
                    { memberAccess: v as MemberAccess },
                    v === 'none' ? '이제 초대한 사람만 볼 수 있어요' : `조직 전체에 ${LEVEL_LABEL_KO[v as MemberAccess]} 권한을 줬어요`,
                  )
                }
              />
            </li>

            {teamGrants.map((g) => (
              <li key={g.teamId} className={s.row}>
                <span className={s.teamMark}>
                  <Icon name="users" size={14} />
                </span>
                <span className={s.who}>
                  <span className={s.whoName}>{g.team!.name}</span>
                  <span className={s.whoMeta}>팀 · {g.team!.memberIds.length}명</span>
                </span>
                <LevelSelect
                  value={g.level}
                  options={LEVELS}
                  label={`${g.team!.name} 팀 권한`}
                  disabled={!canManage}
                  onRemove={canManage ? () => void apply({ teams: [{ teamId: g.teamId, level: null }] }) : undefined}
                  onChange={(v) => void apply({ teams: [{ teamId: g.teamId, level: v as AccessLevel }] })}
                />
              </li>
            ))}

            {memberGrants.map((g) => {
              const me = g.userId === app.user?.id;
              return (
                <li key={g.userId} className={s.row}>
                  <Avatar name={g.member!.name} size="sm" className={s.avatar} />
                  <span className={s.who}>
                    <span className={s.whoName}>
                      {g.member!.name}
                      {me && <span className={s.me}> (나)</span>}
                    </span>
                    <span className={s.whoMeta}>{g.member!.email}</span>
                  </span>
                  <LevelSelect
                    value={g.level}
                    options={LEVELS}
                    label={`${g.member!.name} 권한`}
                    disabled={!canManage}
                    onRemove={canManage ? () => void apply({ members: [{ userId: g.userId, level: null }] }) : undefined}
                    onChange={(v) => void apply({ members: [{ userId: g.userId, level: v as AccessLevel }] })}
                  />
                </li>
              );
            })}

            <li className={cx(s.row, s.adminRow)}>
              <span className={s.orgMark}>
                <Icon name="shield" size={15} />
              </span>
              <span className={s.who}>
                <span className={s.whoName}>소유자 · 관리자 {admins.length}명</span>
                <span className={s.whoMeta}>{admins.map((a) => `${a.name}(${ROLE_LABEL_KO[a.role]})`).join(', ')}</span>
              </span>
              <span className={s.fixedLevel}>항상 관리</span>
            </li>
          </ul>
        </div>
      )}
    </Modal>
  );
}

function LevelSelect({
  value,
  options,
  onChange,
  onRemove,
  label,
  disabled,
}: {
  value: string;
  options: readonly string[];
  onChange: (v: string) => void;
  onRemove?: () => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <span className={s.level}>
      <select
        className={s.select}
        value={value}
        aria-label={label}
        disabled={disabled}
        onChange={(e) => (e.target.value === '__remove' ? onRemove?.() : onChange(e.target.value))}
      >
        {options.map((o) => (
          <option key={o} value={o}>
            {LEVEL_LABEL_KO[o as AccessLevel | 'none']}
          </option>
        ))}
        {onRemove && (
          <>
            <option disabled>──────</option>
            <option value="__remove">권한 제거</option>
          </>
        )}
      </select>
      {!disabled && <Icon name="chevronDown" size={13} className={s.selectChev} />}
    </span>
  );
}
