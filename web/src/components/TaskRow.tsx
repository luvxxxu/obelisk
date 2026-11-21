'use client';

import { addDays, diffDays, formatDurationKo, startOfWeek, type ISODate, type Task } from '@obelisk/core';
import { memo, useMemo, useRef, useState } from 'react';
import { useClock } from '@/lib/clock';
import { cx, dateTone, dueSoonLabel, overdueLabel, spanLabel, timeLabel } from '@/lib/format';
import { previewFor, requestDateChange } from '@/lib/reschedule';
import { clearPicks, getPicked, pickableRowIds, pickRange, togglePick, useIsPicked } from '@/lib/selection';
import { keyLetter } from '@/lib/shortcuts';
import { canEdit, getState, memberAvatar, memberName, selectTask, toggleDone, updateTask, useApp } from '@/lib/store';
import { actionTargets, completeTasks } from '@/lib/task-actions';
import { useElapsed, useRunning } from '@/lib/timeplan';
import { setUi, useUi } from '@/lib/ui-state';
import { DatePickerPanel } from './DatePicker';
import { Icon } from './Icon';
import { Avatar, isEnter, Popover, tip, ui } from './primitives';
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
      {...tip(disabled && '보기 전용: 쓰기 권한이 없어요', { side: 'top' })}
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
          <Icon name="postpone" size={16} />
          {o.label}
          <span className={cx(ui.badge, s.effect)} data-tone={o.conflicts ? 'danger' : o.delayed ? 'warn' : 'ok'}>
            {o.conflicts ? `충돌 ${o.conflicts}` : o.delayed ? `${o.delayed}개 밀림` : '영향 없음'}
          </span>
        </button>
      ))}
      <div className={ui.menuSep} />
      <button className={ui.menuItem} onClick={() => setPicking(true)}>
        <Icon name="calendar" size={16} />
        날짜 선택…
      </button>
    </div>
  );
}

/**
 * E / F2: the title becomes a field in place. Enter or leaving it saves (one 제목 변경 undo step),
 * Esc puts the old title back; an empty title is not saved.
 */
function RenameField({ task, onDone }: { task: Task; onDone: (backToRow: boolean) => void }) {
  const [value, setValue] = useState(task.title);
  const finished = useRef(false);

  const finish = (save: boolean, backToRow: boolean) => {
    if (finished.current) return;
    finished.current = true;
    const title = value.trim();
    setUi({ renaming: null });
    if (save && title && title !== task.title) void updateTask(task.id, { title });
    onDone(backToRow);
  };

  return (
    <input
      className={cx(s.title, s.renameInput)}
      value={value}
      maxLength={500}
      autoFocus
      aria-label="작업 제목"
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setValue(e.target.value)}
      // The row opens the task on click; inside the field a click only moves the caret.
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (isEnter(e)) {
          e.preventDefault();
          finish(true, true);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          finish(false, true);
        }
      }}
      onBlur={() => finish(true, false)}
    />
  );
}

export const TaskRow = memo(function TaskRow({
  task,
  showProject = true,
  showDate = true,
}: {
  task: Task;
  showProject?: boolean;
  /** 'time': a day group already names the date, so show only the time (if any). */
  showDate?: boolean | 'time';
}) {
  const app = useApp();
  const { today, deps, tasks, projects, selectedTaskId } = app;
  const [completing, setCompleting] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const postponeRef = useRef<HTMLButtonElement>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  const picked = useIsPicked(task.id);
  const { renaming, taskMenu } = useUi();
  const isRenaming = renaming === task.id;
  // Right-clicked on its own (not as one of the picks): ringed while its menu is open.
  const menuOnRow = taskMenu?.ids.length === 1 && taskMenu.ids[0] === task.id;

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

  // Only rows with a time need the minute tick ("40분 남음", "10분 지남").
  const now = useClock(!!(task.dueTime || task.startTime));
  const tone = dateTone(task, today, now);
  const label = showDate === 'time' ? timeLabel(task) : showDate ? spanLabel(task, today) : null;
  const soon = label && tone !== 'overdue' && now.date === today ? dueSoonLabel(task, now) : null;
  const done = task.status === 'done' || completing;
  const active = task.status === 'todo' || task.status === 'doing';
  const running = useRunning();
  const elapsed = useElapsed(running?.task.id === task.id ? running.entry.startedAt : null);
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

  const runningHere = running?.task.id === task.id;
  const hasMeta = !!(label || project || assignee || waitingOn > 0 || blocking > 0 || task.fixed || task.postponedCount > 1 || task.estimateMinutes || runningHere);

  return (
    <div
      className={cx(
        s.row,
        done && s.done,
        completing && s.completing,
        selectedTaskId === task.id && s.selected,
        picked && s.picked,
        task.status === 'canceled' && s.canceled,
      )}
      ref={rowRef}
      data-task-row={task.id}
      // The one row that can edit its title in place (E / F2, 제목 바꾸기); others open the panel.
      data-renamable=""
      data-context={menuOnRow || undefined}
      data-renaming={isRenaming || undefined}
      aria-selected={picked || undefined}
      tabIndex={0}
      // Shift would otherwise extend a text selection across the rows.
      onMouseDown={(e) => e.shiftKey && e.preventDefault()}
      onClick={(e) => {
        // Shift: a range from the last row picked; ⌘/Ctrl: one row in or out. A plain click opens it.
        if (e.shiftKey) return pickRange(pickableRowIds(), task.id);
        if (e.metaKey || e.ctrlKey) return togglePick(task.id);
        if (getPicked().size) clearPicks();
        selectTask(task.id);
      }}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget || e.altKey || e.metaKey || e.ctrlKey) return;
        if (e.key === 'Enter') selectTask(task.id);
        if ((keyLetter(e) === 'x' && !e.shiftKey) || e.key === ' ') {
          e.preventDefault();
          // With tasks picked the key acts on all of them (the shell's x does the same off the rows).
          const tasks = getState().tasks;
          if ([...getPicked()].some((id) => tasks[id])) void completeTasks(actionTargets());
          else complete();
        }
      }}
    >
      <Checkbox task={done ? { ...task, status: 'done' } : task} onToggle={complete} animate={completing} disabled={!editable} />

      <div className={s.main}>
        <div className={s.content}>
          <div className={s.titleLine}>
            {isRenaming ? (
              <RenameField task={task} onDone={(backToRow) => backToRow && rowRef.current?.focus()} />
            ) : (
              <span className={s.title}>{task.title}</span>
            )}
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
                  className={cx(s.item, s.date)}
                  data-tone={soon ? 'imminent' : tone}
                  {...tip(task.fixed ? '고정 일정: 날짜가 움직이지 않아요' : soon || tone === 'overdue' ? label : null, { side: 'top' })}
                >
                  {task.fixed && <Icon name="pin" size={13} />}
                  {tone === 'overdue' && task.dueDate ? overdueLabel(task.dueDate, today, task.dueTime, now) : (soon ?? label)}
                </span>
              )}
              {!label && task.fixed && (
                <span className={s.item} {...tip('날짜가 움직이지 않는 고정 일정', { side: 'top' })}>
                  <Icon name="pin" size={13} /> 고정
                </span>
              )}
              {waitingOn > 0 && active && (
                <span className={s.item} {...tip(`먼저 끝나야 하는 작업 ${waitingOn}개`, { side: 'top' })}>
                  <Icon name="lock" size={13} /> 대기 {waitingOn}
                </span>
              )}
              {blocking > 0 && active && (
                <span className={s.item} {...tip(`이 작업을 기다리는 작업 ${blocking}개`, { side: 'top' })}>
                  <Icon name="link" size={13} /> 후속 {blocking}
                </span>
              )}
              {runningHere ? (
                <span className={s.item} data-tone="running" {...tip('기록 중', { side: 'top' })}>
                  <span className={s.liveDot} aria-hidden="true" />
                  {formatDurationKo(task.actualMinutes + Math.floor(elapsed / 60) || 1)}
                  {task.estimateMinutes ? ` / ${formatDurationKo(task.estimateMinutes)}` : ''}
                </span>
              ) : (
                task.estimateMinutes &&
                active && (
                  <span className={s.item} {...tip(task.actualMinutes ? `예상 ${formatDurationKo(task.estimateMinutes)} · 지금까지 ${formatDurationKo(task.actualMinutes)}` : '예상 시간', { side: 'top' })}>
                    <Icon name="timer" size={13} />
                    {task.actualMinutes ? `${formatDurationKo(task.actualMinutes)} / ` : ''}
                    {formatDurationKo(task.estimateMinutes)}
                  </span>
                )
              )}
              {task.postponedCount > 1 && active && (
                <span className={s.item} data-tone="warn" {...tip(`${task.postponedCount}번 미뤘어요`, { side: 'top' })}>
                  <Icon name="postpone" size={13} /> {task.postponedCount}회 미룸
                </span>
              )}
              {project && (
                <span className={cx(s.item, s.project)}>
                  <span className={s.swatch} style={{ background: `var(--c-${project.color})` }} aria-hidden="true" />
                  <span className={s.projectName}>{project.name}</span>
                </span>
              )}
              {assignee && (
                <span className={s.assignee} {...tip(`담당 ${assignee}`, { side: 'top' })}>
                  <Avatar name={assignee} src={memberAvatar(task.assigneeId, app)} size="sm" className={s.assigneeAvatar} />
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
