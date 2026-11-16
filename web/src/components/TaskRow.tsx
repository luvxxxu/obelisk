'use client';

import { addDays, diffDays, startOfWeek, type ISODate, type Task } from '@obelisk/core';
import { memo, useMemo, useRef, useState } from 'react';
import { cx, dateTone, overdueLabel, spanLabel, type DateTone } from '@/lib/format';
import { previewFor, requestDateChange } from '@/lib/reschedule';
import { canEdit, memberName, selectTask, toggleDone, useApp } from '@/lib/store';
import { DatePickerPanel } from './DatePicker';
import { Icon } from './Icon';
import { Avatar, Popover, tip, ui, type BadgeTone } from './primitives';
import s from './TaskRow.module.css';

export function shiftSpan(t: Pick<Task, 'startDate' | 'dueDate'>, days: number) {
  return {
    startDate: t.startDate ? addDays(t.startDate, days) : null,
    dueDate: t.dueDate ? addDays(t.dueDate, days) : null,
  };
}

/** Move a task so it finishes on `target`, keeping its length. */
export function spanEndingOn(t: Pick<Task, 'startDate' | 'dueDate'>, target: ISODate) {
  const anchor = t.dueDate ?? t.startDate;
  if (!anchor) return { startDate: null, dueDate: target };
  return shiftSpan(t, diffDays(target, anchor));
}

/**
 * Round task checkbox. Priority tints the ring (높음 red · 보통 amber · 낮음 blue), "doing" shows a
 * half-filled disc, done is filled with the primary colour. `animate` plays the completion pop once.
 */
export function Checkbox({
  task,
  onToggle,
  size = 18,
  animate = false,
  disabled = false,
}: {
  task: Pick<Task, 'status' | 'priority'>;
  onToggle: () => void;
  size?: number;
  /** Read-only task: shown, but can't be ticked. */
  disabled?: boolean;
  /** Play the subtle completion animation (used while a row is completing). */
  animate?: boolean;
}) {
  const done = task.status === 'done';
  return (
    <button
      className={s.check}
      data-priority={task.priority}
      data-done={done}
      data-doing={task.status === 'doing'}
      data-animate={animate}
      style={{ width: size, height: size }}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      aria-label={disabled ? '보기 전용' : done ? '완료 취소' : '완료'}
      {...tip(disabled && '보기 전용 — 쓰기 권한이 없어요', { side: 'top' })}
    >
      <svg viewBox="0 0 24 24" width={size - 6} height={size - 6} aria-hidden="true">
        <path d="m5 12.5 4.5 4.5L19 7.5" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  );
}

function PostponeMenu({ task, onClose }: { task: Task; onClose: () => void }) {
  const { today } = useApp();
  const [picking, setPicking] = useState(false);
  const anchor = task.dueDate ?? task.startDate;

  const options = useMemo(() => {
    if (!anchor) return [];
    const nextMon = addDays(startOfWeek(today), 7);
    const base = anchor < today ? today : anchor;
    const list = [
      { label: anchor < today ? '오늘로' : '하루 미루기', next: anchor < today ? spanEndingOn(task, today) : shiftSpan(task, 1) },
      { label: '이틀 미루기', next: spanEndingOn(task, addDays(base, 2)) },
      { label: '일주일 미루기', next: spanEndingOn(task, addDays(base, 7)) },
      { label: '다음 주 월요일', next: spanEndingOn(task, nextMon) },
    ];
    return list
      .filter((o) => (o.next.dueDate ?? o.next.startDate) !== anchor)
      .map((o) => {
        const p = previewFor(task.id, o.next);
        return { ...o, delayed: p.report.summary.delayedCount, conflicts: p.report.summary.conflictCount };
      });
  }, [task, anchor, today]);

  if (picking || !anchor) {
    return (
      <DatePickerPanel
        value={task.dueDate}
        today={today}
        clearable={false}
        onPick={(d) => {
          if (d) requestDateChange(task.id, spanEndingOn(task, d));
          onClose();
        }}
      />
    );
  }

  return (
    <div className={s.postponeMenu}>
      <div className={ui.menuTitle}>미루면 어떻게 될까요?</div>
      {options.map((o) => (
        <button
          key={o.label}
          className={ui.menuItem}
          onClick={() => {
            requestDateChange(task.id, o.next);
            onClose();
          }}
        >
          <Icon name="postpone" size={15} />
          {o.label}
          <span className={cx(ui.badge, s.effect)} data-tone={o.conflicts ? 'danger' : o.delayed ? 'warn' : 'ok'}>
            {o.conflicts ? `충돌 ${o.conflicts}` : o.delayed ? `${o.delayed}개 밀림` : '영향 없음'}
          </span>
        </button>
      ))}
      <div className={ui.menuSep} />
      <button className={ui.menuItem} onClick={() => setPicking(true)}>
        <Icon name="calendar" size={15} />
        날짜 선택…
      </button>
    </div>
  );
}

/** Date badge colour by urgency: overdue red · today blue · soon amber · otherwise muted. */
const DATE_BADGE: Record<DateTone, BadgeTone> = {
  overdue: 'danger',
  today: 'info',
  soon: 'warn',
  default: 'secondary',
  done: 'secondary',
};

export const TaskRow = memo(function TaskRow({
  task,
  showProject = true,
  showDate = true,
}: {
  task: Task;
  showProject?: boolean;
  showDate?: boolean;
}) {
  const app = useApp();
  const { today, deps, tasks, projects, selectedTaskId } = app;
  const [completing, setCompleting] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const postponeRef = useRef<HTMLButtonElement>(null);

  const project = showProject && task.projectId ? projects.find((p) => p.id === task.projectId) : null;
  const waitingOn = deps.filter((d) => {
    if (d.taskId !== task.id) return false;
    const b = tasks[d.dependsOnId];
    return b && (b.status === 'todo' || b.status === 'doing');
  }).length;
  const blocking = deps.filter((d) => {
    if (d.dependsOnId !== task.id) return false;
    const n = tasks[d.taskId];
    return n && (n.status === 'todo' || n.status === 'doing');
  }).length;

  const tone = dateTone(task, today);
  const label = showDate ? spanLabel(task, today) : null;
  const done = task.status === 'done' || completing;
  const active = task.status === 'todo' || task.status === 'doing';
  const editable = canEdit(task, app);
  const canPostpone = editable && active && !!(task.dueDate || task.startDate);
  const org = app.workspace?.kind === 'org';
  const assignee = org && task.assigneeId ? (memberName(task.assigneeId, app) ?? '전 멤버') : null;

  const complete = () => {
    if (task.status === 'done' || !editable) return void toggleDone(task.id);
    setCompleting(true);
    window.setTimeout(() => {
      void toggleDone(task.id).finally(() => setCompleting(false));
    }, 380);
  };

  const hasMeta = !!(label || project || assignee || waitingOn > 0 || blocking > 0 || task.fixed || task.postponedCount > 1);

  return (
    <div
      className={cx(
        s.row,
        done && s.done,
        completing && s.completing,
        selectedTaskId === task.id && s.selected,
        task.status === 'canceled' && s.canceled,
      )}
      data-task-row={task.id}
      tabIndex={0}
      onClick={() => selectTask(task.id)}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter') selectTask(task.id);
        if (e.key === 'x' || e.key === ' ') {
          e.preventDefault();
          complete();
        }
      }}
    >
      <Checkbox task={done ? { ...task, status: 'done' } : task} onToggle={complete} animate={completing} disabled={!editable} />

      <div className={s.main}>
        <div className={s.content}>
          <div className={s.titleLine}>
            <span className={s.title}>{task.title}</span>
            {task.notes && (
              <span className={s.noteIcon} {...tip('메모 있음', { side: 'top' })}>
                <Icon name="list" size={13} />
              </span>
            )}
          </div>
          {hasMeta && (
            <div className={s.meta}>
              {label && (
                <span
                  className={cx(ui.badge, s.badge, s.date)}
                  data-tone={DATE_BADGE[tone]}
                  {...tip(task.fixed ? '고정 일정 — 날짜가 움직이지 않아요' : null, { side: 'top' })}
                >
                  <Icon name={task.fixed ? 'pin' : 'calendar'} size={12} />
                  {tone === 'overdue' && task.dueDate ? overdueLabel(task.dueDate, today) : label}
                </span>
              )}
              {!label && task.fixed && (
                <span className={cx(ui.badge, s.badge)} data-tone="outline" {...tip('날짜가 움직이지 않는 고정 일정', { side: 'top' })}>
                  <Icon name="pin" size={12} /> 고정
                </span>
              )}
              {waitingOn > 0 && active && (
                <span className={cx(ui.badge, s.badge)} data-tone="outline" {...tip(`먼저 끝나야 하는 작업 ${waitingOn}개`, { side: 'top' })}>
                  <Icon name="lock" size={12} /> 대기 {waitingOn}
                </span>
              )}
              {blocking > 0 && active && (
                <span className={cx(ui.badge, s.badge)} data-tone="outline" {...tip(`이 작업을 기다리는 작업 ${blocking}개`, { side: 'top' })}>
                  <Icon name="link" size={12} /> 후속 {blocking}
                </span>
              )}
              {task.postponedCount > 1 && active && (
                <span className={cx(ui.badge, s.badge)} data-tone="warn" {...tip(`${task.postponedCount}번 미뤘어요`, { side: 'top' })}>
                  <Icon name="postpone" size={12} /> {task.postponedCount}회 미룸
                </span>
              )}
              {project && (
                <span className={s.project}>
                  <span className={ui.dot} style={{ background: `var(--c-${project.color})` }} />
                  <span className={s.projectName}>{project.name}</span>
                </span>
              )}
              {assignee && (
                <span className={s.assignee} {...tip(`담당 ${assignee}`, { side: 'top' })}>
                  <Avatar name={assignee} size="sm" className={s.assigneeAvatar} />
                  <span className={s.assigneeName}>{assignee}</span>
                </span>
              )}
            </div>
          )}
        </div>
      </div>

      <div className={s.actions} data-open={menuOpen}>
        {canPostpone && (
          <button
            ref={postponeRef}
            className={ui.iconBtn}
            aria-label="미루기 (영향 미리보기)"
            aria-haspopup="dialog"
            aria-expanded={menuOpen}
            data-active={menuOpen}
            {...tip('미루기', { side: 'top', meta: '영향 미리보기' })}
            onClick={(e) => {
              e.stopPropagation();
              setMenuOpen((o) => !o);
            }}
          >
            <Icon name="postpone" size={15} />
          </button>
        )}
        <button
          className={cx(ui.iconBtn, s.openBtn)}
          aria-label="열기"
          tabIndex={-1}
          {...tip('열기', { side: 'top', kbd: '↵' })}
          onClick={(e) => {
            e.stopPropagation();
            selectTask(task.id);
          }}
        >
          <Icon name="chevronRight" size={15} />
        </button>
      </div>
      <Popover anchor={postponeRef} open={menuOpen} onClose={() => setMenuOpen(false)} align="end">
        <div onClick={(e) => e.stopPropagation()}>
          <PostponeMenu task={task} onClose={() => setMenuOpen(false)} />
        </div>
      </Popover>
    </div>
  );
});
