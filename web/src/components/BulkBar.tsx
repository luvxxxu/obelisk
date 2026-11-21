'use client';

import { PRIORITY_LABEL_KO, type Priority, type Task } from '@obelisk/core';
import { useEffect, useRef, useState, type ReactNode, type Ref } from 'react';
import { clearPicks, usePicked } from '@/lib/selection';
import { canWriteProject, useApp } from '@/lib/store';
import { completeTasks, moveToProject, moveToToday, postponeTasks, setPriority as setPriorityOf, trashTasks } from '@/lib/task-actions';
import { isApple, modCombo } from '@/lib/ui-helpers';
import { Icon, type IconName } from './Icon';
import { buttonClass, Popover, tip, ui } from './primitives';
import s from './BulkBar.module.css';

const isActive = (t: Task) => t.status === 'todo' || t.status === 'doing';
const PRIORITIES: Priority[] = [3, 2, 1, 0];

/** The frame every selection bar shares: how many are picked, the actions, and 선택 해제 (Esc). */
export function PickBar({
  variant,
  count,
  label,
  full = false,
  onClear,
  children,
}: {
  variant: 'inline' | 'floating';
  count: number;
  /** Many actions: drops to icons sooner when the column is narrow. */
  full?: boolean;
  /** What the toolbar acts on, for screen readers (`고른 작업`). */
  label: string;
  onClear: () => void;
  children: ReactNode;
}) {
  return (
    <div className={s.bar} data-variant={variant} data-full={full || undefined} role="toolbar" aria-label={label}>
      <span className={s.count}>
        <strong>{count}</strong>개 선택
      </span>
      <span className={s.actions}>{children}</span>
      <button type="button" className={s.clear} onClick={onClear} aria-label="선택 해제">
        <span className={s.label}>선택 해제</span>
        <kbd>Esc</kbd>
        <Icon name="x" size={14} className={s.clearX} />
      </button>
    </div>
  );
}

/**
 * One action of a selection bar. The tooltip names it with its key, so the bar teaches the
 * shortcuts; where the words do not fit (phones) it is the icon alone.
 */
export function BarButton({
  ref,
  icon,
  label,
  name,
  kbd,
  note,
  danger = false,
  disabled = false,
  open,
  onClick,
}: {
  ref?: Ref<HTMLButtonElement>;
  icon: IconName;
  label: string;
  /** The full name, for the tooltip and screen readers, when `label` is short (`삭제` → `휴지통으로 옮기기`). */
  name?: string;
  kbd?: string;
  /** A short line in the tooltip: why it is off, or that it acts on some of them only. */
  note?: string | null;
  danger?: boolean;
  disabled?: boolean;
  /** A menu button: shows a caret, and whether its menu is open. */
  open?: boolean;
  onClick: () => void;
}) {
  const menu = open !== undefined;
  return (
    <button
      ref={ref}
      type="button"
      className={buttonClass({ variant: danger ? 'dangerGhost' : 'outline', size: 'sm', className: s.action })}
      aria-label={name ?? label}
      aria-haspopup={menu ? 'menu' : undefined}
      aria-expanded={menu ? open : undefined}
      data-active={menu ? open : undefined}
      disabled={disabled}
      onClick={onClick}
      {...tip(!open && (name ?? label), { side: 'top', kbd: disabled ? undefined : kbd, meta: note })}
    >
      <Icon name={icon} size={14} />
      <span className={s.label}>{label}</span>
      {menu && <Icon name="chevronDown" size={13} className={s.caret} />}
    </button>
  );
}

/**
 * What can be done to the picked tasks at once: 완료, 오늘로, 하루 미루기, 프로젝트, 우선순위, 삭제.
 * `inline` sits in the timeline's legend row; `floating` hovers at the bottom of a list page.
 */
export function BulkBar({ variant }: { variant: 'inline' | 'floating' }) {
  const app = useApp();
  const picked = usePicked();
  const [menu, setMenu] = useState<'project' | 'priority' | null>(null);
  const projectBtn = useRef<HTMLButtonElement>(null);
  const priorityBtn = useRef<HTMLButtonElement>(null);

  const list = [...picked].map((id) => app.tasks[id]).filter((t): t is Task => !!t);
  if (!list.length) return null;
  const active = list.filter(isActive);
  const dated = active.filter((t) => t.startDate || t.dueDate);
  const projects = app.projects.filter((p) => !p.archivedAt && canWriteProject(p.id, app));
  const sameProject = list.every((t) => t.projectId === list[0]!.projectId) ? list[0]!.projectId : undefined;
  const samePriority = list.every((t) => t.priority === list[0]!.priority) ? list[0]!.priority : undefined;
  const n = list.length;
  const ids = list.map((t) => t.id);

  // The shared commands (lib/task-actions) do the work, so the bar, the keys and the menu take the same ⌘Z.
  const complete = async () => {
    if (!active.length) return;
    await completeTasks(active.map((t) => t.id));
    clearPicks();
  };

  const moveTo = async (projectId: string | null) => {
    setMenu(null);
    // They usually leave the list on screen, so the selection goes with them (kept when nothing moved).
    if (await moveToProject(ids, projectId)) clearPicks();
  };

  const setPriority = async (priority: Priority) => {
    setMenu(null);
    await setPriorityOf(ids, priority);
  };

  const some = (k: number) => (k < n ? `열린 작업 ${k}개만` : null);

  return (
    <PickBar variant={variant} count={n} label="고른 작업" full onClear={clearPicks}>
      <BarButton
        icon="check"
        label="완료"
        kbd={modCombo('↵')}
        disabled={!active.length}
        note={active.length ? some(active.length) : '이미 끝난 작업이에요'}
        onClick={() => void complete()}
      />
      <BarButton
        icon="sun"
        label="오늘로"
        kbd="T"
        disabled={!active.length}
        note={active.length ? some(active.length) : '이미 끝난 작업이에요'}
        onClick={() => moveToToday(ids)}
      />
      <BarButton
        icon="postpone"
        label="하루 미루기"
        kbd="P"
        disabled={!dated.length}
        note={dated.length ? (dated.length < n ? `날짜가 있는 ${dated.length}개만` : null) : '날짜가 있는 작업이 없어요'}
        onClick={() => postponeTasks(ids)}
      />
      <BarButton
        ref={projectBtn}
        icon="folder"
        label="프로젝트"
        name="프로젝트로 옮기기"
        // Only list rows can be dragged onto the sidebar; the timeline's bars move dates instead.
        note={variant === 'floating' ? '사이드바의 프로젝트에 끌어다 놓아도 돼요' : null}
        open={menu === 'project'}
        onClick={() => setMenu((m) => (m === 'project' ? null : 'project'))}
      />
      <BarButton
        ref={priorityBtn}
        icon="flag"
        label="우선순위"
        name="우선순위 바꾸기"
        kbd="1~4"
        open={menu === 'priority'}
        onClick={() => setMenu((m) => (m === 'priority' ? null : 'priority'))}
      />
      <BarButton icon="trash" label="삭제" name="휴지통으로 옮기기" kbd={isApple() ? '⌫' : 'Del'} danger onClick={() => trashTasks(ids)} />

      <Popover anchor={projectBtn} open={menu === 'project'} onClose={() => setMenu(null)} width={240}>
        <div role="menu" aria-label="프로젝트로 옮기기">
          <div className={ui.menuTitle}>프로젝트로 옮기기</div>
          <button type="button" role="menuitem" className={ui.menuItem} data-selected={sameProject === null} onClick={() => void moveTo(null)}>
            <Icon name="inbox" size={16} />
            <span className={s.menuText}>인박스 (프로젝트 없음)</span>
            {sameProject === null && <Icon name="check" size={15} />}
          </button>
          {projects.length > 0 && <div className={ui.menuSep} />}
          {projects.map((p) => (
            <button key={p.id} type="button" role="menuitem" className={ui.menuItem} data-selected={sameProject === p.id} onClick={() => void moveTo(p.id)}>
              <span className={s.swatch} style={{ background: `var(--c-${p.color})` }} aria-hidden="true" />
              <span className={s.menuText}>{p.name}</span>
              {sameProject === p.id && <Icon name="check" size={15} />}
            </button>
          ))}
        </div>
      </Popover>

      <Popover anchor={priorityBtn} open={menu === 'priority'} onClose={() => setMenu(null)} width={200}>
        <div role="menu" aria-label="우선순위 바꾸기">
          <div className={ui.menuTitle}>우선순위</div>
          {PRIORITIES.map((p, i) => (
            <button key={p} type="button" role="menuitem" className={ui.menuItem} data-selected={samePriority === p} onClick={() => void setPriority(p)}>
              <span className={s.priorityDot} data-priority={p} aria-hidden="true" />
              <span className={s.menuText}>{PRIORITY_LABEL_KO[p]}</span>
              {samePriority === p ? <Icon name="check" size={15} /> : <span className={ui.menuHint}>{i + 1}</span>}
            </button>
          ))}
        </div>
      </Popover>
    </PickBar>
  );
}

/** Pins a selection bar to the bottom of the main column, with room under the list so it never covers the last rows. */
export function Dock({ children }: { children: ReactNode }) {
  // Toasts move up while the dock holds the bottom edge.
  useEffect(() => {
    document.body.dataset.dock = 'true';
    return () => {
      delete document.body.dataset.dock;
    };
  }, []);
  return (
    <>
      <div className={s.spacer} aria-hidden="true" />
      <div className={s.dock}>{children}</div>
    </>
  );
}

/** The floating bar for list pages. */
export function SelectionDock({ hidden }: { hidden: boolean }) {
  const picked = usePicked();
  const { tasks } = useApp();
  const shown = !hidden && [...picked].some((id) => tasks[id]);
  if (!shown) return null;
  return (
    <Dock>
      <BulkBar variant="floating" />
    </Dock>
  );
}
