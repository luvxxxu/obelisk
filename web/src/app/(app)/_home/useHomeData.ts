'use client';

/**
 * Read-only derivations for the Home dashboard. Every selection mirrors an existing page so the
 * numbers on Home always match what the user sees after clicking through:
 *   today / overdue / done today  → app/(app)/today/page.tsx
 *   next 7 days bucketing         → app/(app)/upcoming/page.tsx (first 7 of its 14 days)
 *   overdue roots + their ripple  → app/(app)/forecast/page.tsx (`roots`)
 *   bottlenecks                   → app/(app)/forecast/page.tsx (`bottlenecks`)
 *   project progress / finish     → app/(app)/projects/[id]/page.tsx (`data`, `risk.slip`)
 *   completions per day           → app/(app)/logbook/page.tsx (completedOn + user timezone)
 * No mutations here.
 */

import {
  addDays,
  compareDone,
  compareTasks,
  diffDays,
  isOverdue,
  selectView,
  simulate,
  type ImpactReport,
  type ISODate,
  type Project,
  type ProjectSlip,
  type Task,
  type TaskImpact,
  type TaskLeverage,
} from '@obelisk/core';
import { useClock } from '@/lib/clock';
import { useMemo } from 'react';
import { completedOn, useForecast, useLeverage, useTasks } from '@/lib/hooks';
import { planItems, useApp } from '@/lib/store';

export type Level = 'danger' | 'warn' | 'ok';

export interface RootRisk {
  task: Task;
  days: number;
  report: ImpactReport;
}

export interface FixedItem {
  task: Task;
  /** The date that matters next: a future start, otherwise the due date. */
  date: ISODate;
  conflict: TaskImpact | null;
}

export interface ProjectRow {
  project: Project;
  done: number;
  total: number;
  finish: ISODate | null;
  slip: ProjectSlip | null;
}

export interface KeyTask {
  task: Task;
  lev: TaskLeverage;
}

/** Fixed commitments shown on Home: today … today + 30. */
export const FIXED_HORIZON_DAYS = 30;

const isActive = (t: Task) => t.status === 'todo' || t.status === 'doing';

export function useHomeData() {
  const app = useApp();
  const { today, user, projects, deps, tasks: byId } = app;
  const tasks = useTasks();
  const fc = useForecast();
  const lev = useLeverage();
  const tz = user?.timezone ?? 'UTC';
  const now = useClock();

  // Same selection as the Today page.
  const day = useMemo(
    () => ({
      overdue: selectView(tasks, 'overdue', today, now),
      todays: selectView(tasks, 'today', today).filter((t) => !isOverdue(t, today, now)),
      done: tasks.filter((t) => t.status === 'done' && completedOn(t, tz) === today).sort(compareDone),
    }),
    [tasks, today, tz, now],
  );

  // Same bucketing as the Upcoming page (by due date, else start date), first 7 days only.
  const week = useMemo(() => {
    const byDay = new Map<string, Task[]>();
    const horizon = addDays(today, 7);
    for (const t of selectView(tasks, 'upcoming', today)) {
      const d = (t.dueDate ?? t.startDate)!;
      if (d > horizon) continue;
      const l = byDay.get(d) ?? [];
      l.push(t);
      byDay.set(d, l);
    }
    const days = Array.from({ length: 7 }, (_, i) => addDays(today, i + 1)).map((date) => ({
      date,
      tasks: (byDay.get(date) ?? []).sort(compareTasks),
    }));
    return { days, count: days.reduce((n, d) => n + d.tasks.length, 0) };
  }, [tasks, today]);

  const inboxCount = useMemo(() => selectView(tasks, 'inbox', today).length, [tasks, today]);

  // One entry per overdue root with only the ripple that root causes (Forecast page logic).
  const roots = useMemo<RootRisk[]>(() => {
    const items = planItems(app);
    return fc.rootIds
      .map((id) => {
        const t = byId[id]!;
        const days = diffDays(today, (t.dueDate ?? t.startDate)!);
        const report: ImpactReport = simulate(items, deps, { [id]: days });
        return { task: t, days, report };
      })
      .sort(
        (a, b) =>
          b.report.summary.conflictCount - a.report.summary.conflictCount ||
          b.report.summary.delayedCount - a.report.summary.delayedCount ||
          b.days - a.days,
      );
  }, [fc, app, byId, deps, today]);

  const fixed = useMemo<FixedItem[]>(() => {
    const conflicts = new Map(fc.impacts.filter((im) => im.kind === 'conflict').map((im) => [im.taskId, im]));
    const end = addDays(today, FIXED_HORIZON_DAYS);
    const out: FixedItem[] = [];
    for (const t of tasks) {
      if (!t.fixed || !isActive(t)) continue;
      const last = t.dueDate ?? t.startDate;
      if (!last || last < today) continue;
      const date = t.startDate && t.startDate >= today ? t.startDate : last;
      if (date > end) continue;
      out.push({ task: t, date, conflict: conflicts.get(t.id) ?? null });
    }
    return out.sort((a, b) => a.date.localeCompare(b.date) || compareTasks(a.task, b.task));
  }, [tasks, fc, today]);

  // Same per-project numbers as the project page header.
  const projectRows = useMemo<ProjectRow[]>(
    () =>
      projects
        .filter((p) => !p.archivedAt)
        .sort((a, b) => a.position - b.position)
        .map((p) => {
          const mine = tasks.filter((t) => t.projectId === p.id);
          const active = mine.filter(isActive);
          const done = mine.filter((t) => t.status === 'done').length;
          const finish =
            active
              .map((t) => t.dueDate ?? t.startDate)
              .filter(Boolean)
              .sort()
              .at(-1) ?? null;
          const slip = fc.summary.projectSlips.find((sl) => sl.projectId === p.id) ?? null;
          return { project: p, done, total: active.length + done, finish, slip };
        }),
    [projects, tasks, fc],
  );

  // Same filter as the Forecast page's 핵심 작업.
  const key = useMemo(() => {
    const bottlenecks = lev.filter((l) => l.delayedIfLate + l.conflictsIfLate > 0 || l.slackDays === 0);
    const items: KeyTask[] = bottlenecks.slice(0, 3).map((l) => ({ lev: l, task: byId[l.taskId]! }));
    return { items, total: bottlenecks.length, linked: lev.length };
  }, [lev, byId]);

  // Completions per day, last 7 days (Logbook semantics: completedAt in the user's timezone).
  const recent = useMemo(() => {
    const counts = new Map<string, number>();
    for (const t of tasks) {
      if (t.status !== 'done') continue;
      const d = completedOn(t, tz);
      if (!d) continue;
      counts.set(d, (counts.get(d) ?? 0) + 1);
    }
    const days = Array.from({ length: 7 }, (_, i) => addDays(today, i - 6)).map((date) => ({
      date,
      count: counts.get(date) ?? 0,
    }));
    return {
      days,
      total: days.reduce((n, d) => n + d.count, 0),
      max: Math.max(0, ...days.map((d) => d.count)),
    };
  }, [tasks, tz, today]);

  const remaining = day.overdue.length + day.todays.length;
  const doing = day.overdue.filter((t) => t.status === 'doing').length + day.todays.filter((t) => t.status === 'doing').length;
  const oldestOverdue = day.overdue.reduce((m, t) => Math.max(m, diffDays(today, t.dueDate!)), 0);
  const delayed = fc.summary.delayedCount;
  const conflicts = fc.summary.conflictCount;
  const level: Level = conflicts > 0 ? 'danger' : day.overdue.length > 0 || delayed > 0 ? 'warn' : 'ok';

  return {
    today,
    user,
    fc,
    overdue: day.overdue,
    todays: day.todays,
    doneToday: day.done,
    remaining,
    doing,
    oldestOverdue,
    delayed,
    conflicts,
    level,
    week,
    inboxCount,
    roots,
    fixed,
    projectRows,
    key,
    recent,
  };
}

export type HomeData = ReturnType<typeof useHomeData>;
