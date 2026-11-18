'use client';

import {
  DAY_MINUTES,
  formatRelativeKo,
  fromMinutes,
  previewDateChange,
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
  await commit(p.taskId, withTimes(changes, p.taskId, p.next), changes.length);
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
