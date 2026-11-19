'use client';

import { PRIORITY_LABEL_KO, type Priority, type Task } from '@obelisk/core';
import { useEffect, useRef, useState } from 'react';
import { requestGroupChange } from '@/lib/reschedule';
import { clearPicks, usePicked } from '@/lib/selection';
import { canWriteProject, deleteTasks, moveTasks, patchTasks, useApp } from '@/lib/store';
import { nextByDays } from '@/lib/timeline';
import { toast } from '@/lib/toast';
import { Icon } from './Icon';
import { buttonClass, ConfirmModal, Popover, tip, ui } from './primitives';
import s from './BulkBar.module.css';

const isActive = (t: Task) => t.status === 'todo' || t.status === 'doing';
const PRIORITIES: Priority[] = [3, 2, 1, 0];

/**
 * What can be done to the picked tasks at once: 완료, 하루 미루기, 프로젝트, 우선순위, 삭제.
 * `inline` sits in the timeline's legend row; `floating` hovers at the bottom of a list page.
 */
export function BulkBar({ variant }: { variant: 'inline' | 'floating' }) {
  const app = useApp();
  const picked = usePicked();
  const [confirmDelete, setConfirmDelete] = useState(false);
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

  const complete = async () => {
    if (!active.length) return;
    const before = active.map((t) => ({ taskId: t.id, position: t.position, status: t.status }));
    const ok = await moveTasks(active.map((t) => ({ taskId: t.id, position: t.position, status: 'done' as const })));
    if (!ok) return;
    toast.show(`작업 ${before.length}개 완료`, { action: { label: '실행 취소', run: () => void moveTasks(before) } });
    clearPicks();
  };

  const postpone = () => {
    if (!dated.length) return;
    requestGroupChange(dated.map((t) => ({ taskId: t.id, next: nextByDays(t, 'move', 1) })));
  };

  const moveTo = async (projectId: string | null) => {
    setMenu(null);
    const moving = list.filter((t) => t.projectId !== projectId);
    if (!moving.length) return;
    const ok = await patchTasks(moving.map((t) => ({ id: t.id, patch: { projectId } })));
    if (!ok) return;
    // They usually leave the list on screen, so the selection goes with them.
    clearPicks();
    const name = projectId ? (app.projects.find((p) => p.id === projectId)?.name ?? '프로젝트') : '인박스';
    toast.show(`작업 ${moving.length}개를 ${name}(으)로 옮겼어요`, {
      action: { label: '실행 취소', run: () => void patchTasks(moving.map((t) => ({ id: t.id, patch: { projectId: t.projectId } }))) },
    });
  };

  const setPriority = async (priority: Priority) => {
    setMenu(null);
    const changing = list.filter((t) => t.priority !== priority);
    if (!changing.length) return;
    const ok = await patchTasks(changing.map((t) => ({ id: t.id, patch: { priority } })));
    if (!ok) return;
    toast.show(`작업 ${changing.length}개 우선순위 ${PRIORITY_LABEL_KO[priority]}`, {
      action: {
        label: '실행 취소',
        run: () => void patchTasks(changing.map((t) => ({ id: t.id, patch: { priority: t.priority as Priority } }))),
      },
    });
  };

  const remove = async () => {
    const ids = list.map((t) => t.id);
    clearPicks();
    await deleteTasks(ids);
  };

  const btn = buttonClass({ variant: 'outline', size: 'sm', className: s.action });

  return (
    <div className={s.bar} data-variant={variant} role="toolbar" aria-label="고른 작업">
      <span className={s.count}>
        <strong>{n}</strong>개 선택
      </span>
      <span className={s.actions}>
        <button type="button" className={btn} aria-label="완료" disabled={!active.length} onClick={() => void complete()} {...tip(!active.length && '이미 끝난 작업이에요', { side: 'top' })}>
          <Icon name="check" size={14} />
          <span className={s.label}>완료</span>
        </button>
        <button
          type="button"
          className={btn}
          aria-label="하루 미루기"
          disabled={!dated.length}
          onClick={postpone}
          {...tip(dated.length ? (dated.length < n ? `날짜가 있는 ${dated.length}개만` : null) : '날짜가 있는 작업이 없어요', { side: 'top' })}
        >
          <Icon name="postpone" size={14} />
          <span className={s.label}>하루 미루기</span>
        </button>
        <button
          ref={projectBtn}
          type="button"
          className={btn}
          aria-label="프로젝트로 옮기기"
          aria-haspopup="menu"
          aria-expanded={menu === 'project'}
          data-active={menu === 'project'}
          onClick={() => setMenu((m) => (m === 'project' ? null : 'project'))}
        >
          <Icon name="folder" size={14} />
          <span className={s.label}>프로젝트</span>
          <Icon name="chevronDown" size={13} className={s.caret} />
        </button>
        <button
          ref={priorityBtn}
          type="button"
          className={btn}
          aria-label="우선순위 바꾸기"
          aria-haspopup="menu"
          aria-expanded={menu === 'priority'}
          data-active={menu === 'priority'}
          onClick={() => setMenu((m) => (m === 'priority' ? null : 'priority'))}
        >
          <Icon name="flag" size={14} />
          <span className={s.label}>우선순위</span>
          <Icon name="chevronDown" size={13} className={s.caret} />
        </button>
        <button type="button" className={buttonClass({ variant: 'dangerGhost', size: 'sm', className: s.action })} aria-label="삭제" onClick={() => setConfirmDelete(true)}>
          <Icon name="trash" size={14} />
          <span className={s.label}>삭제</span>
        </button>
      </span>
      <button type="button" className={s.clear} onClick={clearPicks} aria-label="선택 해제">
        <span className={s.label}>선택 해제</span>
        <kbd>Esc</kbd>
        <Icon name="x" size={14} className={s.clearX} />
      </button>

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
          {PRIORITIES.map((p) => (
            <button key={p} type="button" role="menuitem" className={ui.menuItem} data-selected={samePriority === p} onClick={() => void setPriority(p)}>
              <span className={s.priorityDot} data-priority={p} aria-hidden="true" />
              <span className={s.menuText}>{PRIORITY_LABEL_KO[p]}</span>
              {samePriority === p && <Icon name="check" size={15} />}
            </button>
          ))}
        </div>
      </Popover>

      <ConfirmModal
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title={`작업 ${n}개를 삭제할까요?`}
        body="고른 작업과 그 의존 관계가 함께 삭제돼요. 되돌릴 수 없어요."
        confirmLabel="삭제"
        onConfirm={() => void remove()}
      />
    </div>
  );
}

/** The floating bar for list pages, plus room under the list so it never covers the last rows. */
export function SelectionDock({ hidden }: { hidden: boolean }) {
  const picked = usePicked();
  const { tasks } = useApp();
  const shown = !hidden && [...picked].some((id) => tasks[id]);
  // Toasts move up while the dock holds the bottom edge.
  useEffect(() => {
    if (!shown) return;
    document.body.dataset.dock = 'true';
    return () => {
      delete document.body.dataset.dock;
    };
  }, [shown]);
  if (!shown) return null;
  return (
    <>
      <div className={s.spacer} aria-hidden="true" />
      <div className={s.dock}>
        <BulkBar variant="floating" />
      </div>
    </>
  );
}
