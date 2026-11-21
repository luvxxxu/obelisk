'use client';

import { forecast, leverage, todayIn, type Task } from '@obelisk/core';
import { useEffect, useMemo, useState } from 'react';
import { planItems, useApp } from './store';

export function useTasks(): Task[] {
  const { tasks } = useApp();
  return useMemo(() => Object.values(tasks), [tasks]);
}

export function useForecast() {
  const app = useApp();
  return useMemo(() => forecast(planItems(app), app.deps, app.today), [app]);
}

export function useLeverage() {
  const app = useApp();
  return useMemo(() => leverage(planItems(app), app.deps), [app]);
}

export function completedOn(t: Task, tz: string): string | null {
  return t.completedAt ? todayIn(tz, new Date(t.completedAt)) : null;
}

const PREF_EVENT = 'obelisk:pref';

/** Change a remembered preference from anywhere (a mounted usePref follows it). */
export function setPref(key: string, value: string) {
  try {
    localStorage.setItem(`obelisk:${key}`, value);
  } catch {}
  window.dispatchEvent(new CustomEvent(PREF_EVENT, { detail: { key, value } }));
}

/** Per-view preference remembered in localStorage. */
export function usePref<T extends string>(key: string, initial: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(initial);
  useEffect(() => {
    try {
      const saved = localStorage.getItem(`obelisk:${key}`);
      if (saved) setV(saved as T);
    } catch {}
    const on = (e: Event) => {
      const d = (e as CustomEvent<{ key: string; value: string }>).detail;
      if (d?.key === key) setV(d.value as T);
    };
    window.addEventListener(PREF_EVENT, on);
    return () => window.removeEventListener(PREF_EVENT, on);
  }, [key]);
  return [v, (next: T) => setPref(key, next)];
}
