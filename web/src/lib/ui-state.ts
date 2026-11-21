'use client';

import { useSyncExternalStore } from 'react';

export type JevDialog = { kind: 'priority' } | { kind: 'postpone'; scope: 'today' | 'week' };

/** "약속하기 전에": an existing task, or new work prefilled from quick add. */
export interface CommitDialogState {
  taskId?: string;
  title?: string;
  estimateMinutes?: number | null;
  projectId?: string | null;
  date?: string | null;
}

export interface UiState {
  quickAdd: boolean;
  palette: boolean;
  shortcuts: boolean;
  nav: boolean;
  /** Desktop sidebar shown as a 52px icon rail (persisted in localStorage `obelisk:sidebar`). */
  sidebarCollapsed: boolean;
  /** An open Jev dialog (priority suggestions, what to postpone). */
  jev: JevDialog | null;
  /** The promise-date dialog. */
  commit: CommitDialogState | null;
  /** "실제 시간 고치기" for a task. */
  actual: { taskId: string } | null;
  /** The task whose title is being edited in place in its row (E / F2). */
  renaming: string | null;
  /** The open task context menu: where it was asked for and which tasks it acts on. */
  taskMenu: { x: number; y: number; ids: string[] } | null;
  /** A batch of 10 or more tasks waiting for the 휴지통 confirmation. */
  confirmTrash: string[] | null;
}

let ui: UiState = {
  quickAdd: false,
  palette: false,
  shortcuts: false,
  nav: false,
  sidebarCollapsed: false,
  jev: null,
  commit: null,
  actual: null,
  renaming: null,
  taskMenu: null,
  confirmTrash: null,
};
const listeners = new Set<() => void>();

export function setUi(patch: Partial<UiState>) {
  ui = { ...ui, ...patch };
  listeners.forEach((l) => l());
}

export function getUi() {
  return ui;
}

export function useUi() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => ui,
    () => ui,
  );
}
