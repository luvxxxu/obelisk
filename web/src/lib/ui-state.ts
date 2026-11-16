'use client';

import { useSyncExternalStore } from 'react';

export type JevDialog = { kind: 'priority' } | { kind: 'postpone'; scope: 'today' | 'week' };

export interface UiState {
  quickAdd: boolean;
  palette: boolean;
  shortcuts: boolean;
  nav: boolean;
  /** Desktop sidebar shown as a 52px icon rail (persisted in localStorage `obelisk:sidebar`). */
  sidebarCollapsed: boolean;
  /** An open Jev dialog (priority suggestions, what to postpone). */
  jev: JevDialog | null;
}

let ui: UiState = { quickAdd: false, palette: false, shortcuts: false, nav: false, sidebarCollapsed: false, jev: null };
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
