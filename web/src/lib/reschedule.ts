'use client';

import {
  DAY_MINUTES,
  formatRelativeKo,
  fromMinutes,
  previewDateChange,
  simulate,
  toDay,
  toMinutes,
  type DateChange,
  type DateChangePreview,
  type DateSpan,
  type ISOTime,
  type Task,
} from '@obelisk/core';
import { useSyncExternalStore } from 'react';
import { withTime } from './format';
import { getState, planItems, reschedule, updateTask } from './store';
import { toast } from './toast';

/** Dates plus, optionally, new times. A time left undefined stays as it is (and goes with a cleared date). */
export interface TimedSpan extends DateSpan {
  startTime?: ISOTime | null;
  dueTime?: ISOTime | null;
}

/** The times a task ends up with after `next`. */
function resolvedTimes(task: Task, next: TimedSpan): { startTime: ISOTime | null; dueTime: ISOTime | null } {
  return {
    startTime: next.startDate ? (next.startTime !== undefined ? next.startTime : task.startTime) : null,
    dueTime: next.dueDate ? (next.dueTime !== undefined ? next.dueTime : task.dueTime) : null,
  };
}

/**
 * Keep a same-day start before its due, the way calendars do: moving the start carries the due
 * time along (keeping the length, an hour by default); moving the due pulls the start back.
 */
export function orderTimes(task: Task, next: TimedSpan): TimedSpan {
  const { startTime: st, dueTime: dt } = resolvedTimes(task, next);
  if (!next.startDate || next.startDate !== next.dueDate || !st || !dt || st <= dt) return next;
  const was = task.startDate === task.dueDate && task.startTime && task.dueTime ? toMinutes(task.dueTime) - toMinutes(task.startTime) : 0;
  const len = was > 0 ? was : 60;
  const dueMoved = next.dueTime !== undefined && next.startTime === undefined;
  return dueMoved
    ? { ...next, startTime: fromMinutes(Math.max(0, toMinutes(dt) - len)) }
    : { ...next, dueTime: fromMinutes(Math.min(DAY_MINUTES - 1, toMinutes(st) + len)) };
}

/** Put the edited task's new times on its own entry of a previewed change set. */
function withTimes(changes: DateChange[], taskId: string, next: TimedSpan): DateChange[] {
  return changes.map((c) =>
    c.taskId !== taskId
      ? c
      : {
          ...c,
          ...(next.startTime !== undefined ? { startTime: next.startTime } : {}),
          ...(next.dueTime !== undefined ? { dueTime: next.dueTime } : {}),
        },
  );
}

/**
 * Every date edit in the UI goes through here. If moving a task would push
 * other work or break a fixed date, we stop and show the impact first.
 */
export interface PendingChange {
  taskId: string;
  title: string;
  next: TimedSpan;
  preview: DateChangePreview;
  /** Set when several tasks move together; `only`/`cascade` then already carry every task's times. */
  count?: number;
}

let pending: PendingChange | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function usePendingChange() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => pending,
    () => pending,
  );
}

export function previewFor(taskId: string, next: DateSpan) {
  const s = getState();
  return previewDateChange(planItems(s), s.deps, taskId, next);
}

export function requestDateChange(taskId: string, span: TimedSpan) {
  const s = getState();
  const task = s.tasks[taskId];
  if (!task) return;
  const next = orderTimes(task, span);
  const times = resolvedTimes(task, next);
  const sameDates = task.startDate === next.startDate && task.dueDate === next.dueDate;
  if (sameDates) {
    // A new time on the same day moves nothing else: the delay model counts whole days.
    if (times.startTime !== task.startTime || times.dueTime !== task.dueTime) void updateTask(taskId, times);
    return;
  }
  const preview = previewFor(taskId, next);
  if (preview.hasImpact) {
    pending = { taskId, title: task.title, next, preview };
    emit();
    return;
  }
  void commit(taskId, withTimes(preview.only, taskId, next), 1);
}

export async function resolvePending(mode: 'cascade' | 'only' | 'cancel') {
  const p = pending;
  pending = null;
  emit();
  if (!p || mode === 'cancel') return;
  const changes = mode === 'cascade' ? p.preview.cascade : p.preview.only;
  await commit(p.taskId, p.count ? changes : withTimes(changes, p.taskId, p.next), changes.length);
}

export interface GroupMove {
  taskId: string;
  next: TimedSpan;
}

/**
 * The same preview for several tasks moved together (the timeline's multi-select): every moved
 * task is a root, each pushing its successors by however far its own finish moved.
 */
export function previewGroup(moves: GroupMove[]): DateChangePreview {
  const s = getState();
  const roots = new Map(moves.map((m) => [m.taskId, m.next]));
  const shifts: Record<string, number> = {};
  let shiftDays = 0;
  for (const m of moves) {
    const t = s.tasks[m.taskId];
    const oldEnd = t ? (t.dueDate ?? t.startDate) : null;
    const newEnd = m.next.dueDate ?? m.next.startDate;
    const d = oldEnd && newEnd ? toDay(newEnd) - toDay(oldEnd) : 0;
    shifts[m.taskId] = d;
    if (Math.abs(d) > Math.abs(shiftDays)) shiftDays = d;
  }
  const report = simulate(planItems(s), s.deps, shifts);
  for (const im of report.impacts) {
    const next = roots.get(im.taskId);
    if (next && im.kind === 'root') im.to = { startDate: next.startDate, dueDate: next.dueDate };
  }
  const only: DateChange[] = moves.map((m) => {
    const t = s.tasks[m.taskId]!;
    const next = orderTimes(t, m.next);
    return { taskId: m.taskId, startDate: next.startDate, dueDate: next.dueDate, ...resolvedTimes(t, next) };
  });
  const cascade = [
    ...only,
    ...report.impacts
      .filter((im) => im.kind === 'shifted' && !roots.has(im.taskId))
      .map((im) => ({ taskId: im.taskId, startDate: im.to.startDate, dueDate: im.to.dueDate })),
  ];
  return {
    report,
    shiftDays,
    startsBeforeBlockers: [],
    hasImpact: report.summary.delayedCount + report.summary.conflictCount > 0,
    only,
    cascade,
  };
}

/** Move several tasks at once; asks first (the same dialog) when other work would be pushed. */
export function requestGroupChange(moves: GroupMove[]) {
  const s = getState();
  const valid = moves.filter((m) => s.tasks[m.taskId]);
  if (!valid.length) return;
  if (valid.length === 1) {
    requestDateChange(valid[0]!.taskId, valid[0]!.next);
    return;
  }
  const preview = previewGroup(valid);
  const first = valid[0]!;
  if (preview.hasImpact) {
    pending = { taskId: first.taskId, title: `작업 ${valid.length}개`, next: first.next, preview, count: valid.length };
    emit();
    return;
  }
  void commit(first.taskId, preview.only, valid.length);
}

async function commit(taskId: string, changes: DateChange[], count: number) {
  const s = getState();
  const before: DateChange[] = changes
    .map((c) => s.tasks[c.taskId])
    .filter((t): t is Task => !!t)
    .map((t) => ({ taskId: t.id, startDate: t.startDate, dueDate: t.dueDate, startTime: t.startTime, dueTime: t.dueTime }));
  const task = s.tasks[taskId];
  const ok = await reschedule(changes, taskId);
  if (!ok || !task) return;
  const after = getState().tasks[taskId];
  const when = after?.dueDate ?? after?.startDate;
  const time = after?.dueDate ? after.dueTime : after?.startTime;
  const label = when ? withTime(formatRelativeKo(when, getState().today), time) : '날짜 없음';
  toast.show(count > 1 ? `${count}개 작업 일정을 함께 옮겼어요` : `“${task.title}” → ${label}`, {
    action: { label: '실행 취소', run: () => void reschedule(before) },
  });
}
