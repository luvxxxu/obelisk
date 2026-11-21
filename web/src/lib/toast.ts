'use client';

import { useSyncExternalStore } from 'react';

export interface Toast {
  id: number;
  message: string;
  tone: 'default' | 'error' | 'success';
  action?: { label: string; run: () => void };
  /** A quieter second action (shown before the main one). */
  secondary?: { label: string; run: () => void };
}

let toasts: Toast[] = [];
let seq = 0;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

function push(t: Omit<Toast, 'id'>, ms = 4200) {
  const id = ++seq;
  toasts = [...toasts.slice(-3), { ...t, id }];
  emit();
  window.setTimeout(() => dismiss(id), ms);
  return id;
}

export function dismiss(id: number) {
  toasts = toasts.filter((t) => t.id !== id);
  emit();
}

export const toast = {
  show: (message: string, opts: { action?: Toast['action']; secondary?: Toast['secondary'] } = {}) =>
    push({ message, tone: 'default', action: opts.action, secondary: opts.secondary }, opts.action ? 6000 : 3600),
  success: (message: string) => push({ message, tone: 'success' }),
  error: (message: string) => push({ message, tone: 'error' }, 6000),
};

export function useToasts() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => toasts,
    () => toasts,
  );
}
