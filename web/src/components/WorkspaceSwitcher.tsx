'use client';

import { isWorkspaceAdmin, ROLE_LABEL_KO, type WorkspaceSummary } from '@obelisk/core';
import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { cx } from '@/lib/format';
import { createWorkspace, switchWorkspace, useApp } from '@/lib/store';
import { Icon, Logo } from './Icon';
import { isEnter, Modal, Popover, ui, useDisclosure } from './primitives';
import s from './WorkspaceSwitcher.module.css';

export function workspaceLabel(w: Pick<WorkspaceSummary, 'kind' | 'name'> | null | undefined): string {
  if (!w) return 'Obelisk';
  return w.kind === 'personal' ? '개인 공간' : w.name;
}

/** Personal space keeps the Obelisk mark; an organization shows its initial. */
export function WorkspaceMark({ ws, size = 'md' }: { ws: Pick<WorkspaceSummary, 'kind' | 'name'> | null | undefined; size?: 'sm' | 'md' | 'lg' }) {
  const org = ws?.kind === 'org';
  return (
    <span className={s.mark} data-size={size} data-kind={org ? 'org' : 'personal'} aria-hidden="true">
      {org ? (ws!.name.trim().slice(0, 1).toUpperCase() || '?') : <Logo size={size === 'lg' ? 20 : size === 'sm' ? 12 : 14} />}
    </span>
  );
}

/**
 * Notion-style switcher at the top of the sidebar: which space you're in, the others you
 * belong to, and the way to start an organization.
 */
export function WorkspaceSwitcher({ onNavigate }: { onNavigate: () => void }) {
  const app = useApp();
  const router = useRouter();
  const ref = useRef<HTMLButtonElement>(null);
  const menu = useDisclosure();
  const create = useDisclosure();
  const ws = app.workspace;
  const admin = isWorkspaceAdmin(ws?.role);

  const go = (href: string) => {
    menu.close();
    onNavigate();
    router.push(href);
  };

  const open = async (w: WorkspaceSummary) => {
    menu.close();
    onNavigate();
    if (w.id === ws?.id) return;
    router.push('/');
    await switchWorkspace(w.id);
  };

  return (
    <>
      <button
        ref={ref}
        className={s.trigger}
        onClick={menu.toggle}
        aria-haspopup="menu"
        aria-expanded={menu.open}
        aria-label={`공간 전환 — 지금: ${workspaceLabel(ws)}`}
      >
        <WorkspaceMark ws={ws} />
        <span className={s.name}>{workspaceLabel(ws)}</span>
        <Icon name="chevronsUpDown" size={14} className={s.chevron} />
      </button>
      <Popover anchor={ref} open={menu.open} onClose={menu.close} width={296} className={s.menu}>
        <div className={s.account}>{app.user?.email}</div>
        {app.workspaces.length > 1 && (
          <>
            <button className={cx(ui.menuItem, s.item)} onClick={() => go('/overview')}>
              <span className={s.mark} data-size="sm" data-kind="all" aria-hidden="true">
                <Icon name="grid" size={12} strokeWidth={2} />
              </span>
              <span className={s.itemText}>
                <span className={s.itemName}>모아보기</span>
                <span className={s.itemMeta}>모든 공간에서 내가 할 일</span>
              </span>
            </button>
            <div className={ui.menuSep} />
          </>
        )}
        <div role="menu" aria-label="공간">
          {app.workspaces.map((w) => {
            const current = w.id === ws?.id;
            return (
              <button
                key={w.id}
                role="menuitemradio"
                aria-checked={current}
                className={cx(ui.menuItem, s.item)}
                data-selected={current}
                onClick={() => void open(w)}
              >
                <WorkspaceMark ws={w} size="sm" />
                <span className={s.itemText}>
                  <span className={s.itemName}>{workspaceLabel(w)}</span>
                  <span className={s.itemMeta}>
                    {w.kind === 'personal' ? '나만 보는 공간' : `${ROLE_LABEL_KO[w.role]} · 멤버 ${w.memberCount}명`}
                  </span>
                </span>
                {current && <Icon name="check" size={15} className={s.check} />}
              </button>
            );
          })}
        </div>
        <div className={ui.menuSep} />
        {ws?.kind === 'org' && (
          <>
            <button className={ui.menuItem} onClick={() => go('/settings/org')}>
              <Icon name="building" size={16} /> 조직 설정
            </button>
            {admin && (
              <button className={ui.menuItem} onClick={() => go('/settings/org?tab=members&invite=1')}>
                <Icon name="userPlus" size={16} /> 멤버 초대
              </button>
            )}
            <div className={ui.menuSep} />
          </>
        )}
        <button className={ui.menuItem} onClick={() => (menu.close(), create.setOpen(true))}>
          <Icon name="plus" size={16} /> 새 조직 만들기
        </button>
      </Popover>
      <CreateOrgModal
        open={create.open}
        onClose={create.close}
        onCreated={() => {
          onNavigate();
          router.push('/settings/org?tab=members&invite=1');
        }}
      />
    </>
  );
}

export function CreateOrgModal({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    const n = name.trim();
    if (!n || busy) return;
    setBusy(true);
    const ws = await createWorkspace(n);
    setBusy(false);
    if (!ws) return;
    setName('');
    onClose();
    onCreated();
  };
  return (
    <Modal
      open={open}
      onClose={onClose}
      width={440}
      icon={<Icon name="building" size={18} />}
      title="새 조직 만들기"
      description="팀과 함께 쓰는 공간이에요. 프로젝트마다 누가 보고, 누가 고칠 수 있는지 정할 수 있어요."
      footer={
        <>
          <button className={cx(ui.btn, ui.outline)} onClick={onClose}>
            취소
          </button>
          <button className={cx(ui.btn, ui.primary)} disabled={!name.trim() || busy} onClick={() => void submit()}>
            만들기
          </button>
        </>
      }
    >
      <div className={ui.field}>
        <label className={ui.label} htmlFor="org-name">
          조직 이름
        </label>
        <input
          id="org-name"
          className={ui.input}
          autoFocus
          placeholder="예: 에이컴퍼니, 디자인 스튜디오"
          maxLength={80}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => isEnter(e) && void submit()}
        />
        <p className={ui.help}>만든 사람이 소유자가 되고, 다음 화면에서 초대 링크로 멤버를 부를 수 있어요.</p>
      </div>
    </Modal>
  );
}
