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

/** Per-view preference remembered in localStorage. */
export function usePref<T extends string>(key: string, initial: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(initial);
  useEffect(() => {
    try {
      const saved = localStorage.getItem(`obelisk:${key}`);
      if (saved) setV(saved as T);
    } catch {}
  }, [key]);
  return [
    v,
    (next: T) => {
      setV(next);
      try {
        localStorage.setItem(`obelisk:${key}`, next);
      } catch {}
    },
  ];
}
