'use client';

import { formatRelativeKo, previewDateChange, type DateChangePreview, type DateSpan } from '@obelisk/core';
import { useSyncExternalStore } from 'react';
import { getState, planItems, reschedule } from './store';
import { toast } from './toast';

/**
 * Every date edit in the UI goes through here. If moving a task would push
 * other work or break a fixed date, we stop and show the impact first.
 */
export interface PendingChange {
  taskId: string;
  title: string;
  next: DateSpan;
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

export function requestDateChange(taskId: string, next: DateSpan) {
  const s = getState();
  const task = s.tasks[taskId];
  if (!task) return;
  if (task.startDate === next.startDate && task.dueDate === next.dueDate) return;
  const preview = previewFor(taskId, next);
  if (preview.hasImpact) {
    pending = { taskId, title: task.title, next, preview };
    emit();
    return;
  }
  void commit(taskId, preview.only, 1);
}

export async function resolvePending(mode: 'cascade' | 'only' | 'cancel') {
  const p = pending;
  pending = null;
  emit();
  if (!p || mode === 'cancel') return;
  await commit(p.taskId, mode === 'cascade' ? p.preview.cascade : p.preview.only, mode === 'cascade' ? p.preview.cascade.length : 1);
}

async function commit(taskId: string, changes: DateChangePreview['only'], count: number) {
  const s = getState();
  const before = changes
    .map((c) => s.tasks[c.taskId])
    .filter(Boolean)
    .map((t) => ({ taskId: t!.id, startDate: t!.startDate, dueDate: t!.dueDate }));
  const task = s.tasks[taskId];
  const ok = await reschedule(changes, taskId);
  if (!ok || !task) return;
  const root = changes.find((c) => c.taskId === taskId);
  const when = root?.dueDate ?? root?.startDate;
  const label = when ? formatRelativeKo(when, getState().today) : '날짜 없음';
  toast.show(count > 1 ? `${count}개 작업 일정을 함께 옮겼어요` : `“${task.title}” → ${label}`, {
    action: { label: '실행 취소', run: () => void reschedule(before) },
  });
}
