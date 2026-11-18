import { dateTimeKey, isPastDue, type Clock, type ISODate } from './dates';
import type { Task } from './types';

export const VIEW_NAMES = ['today', 'upcoming', 'overdue', 'inbox', 'unscheduled', 'all', 'done'] as const;
export type ViewName = (typeof VIEW_NAMES)[number];

type ViewTask = Pick<Task, 'status' | 'startDate' | 'dueDate' | 'projectId' | 'priority' | 'number' | 'completedAt' | 'position'> &
  Partial<Pick<Task, 'startTime' | 'dueTime'>>;

const active = (t: ViewTask) => t.status === 'todo' || t.status === 'doing';

/** Past its due date, or, with `now` and a due time, past that minute today. */
export function isOverdue(t: ViewTask, today: ISODate, now?: Clock | null): boolean {
  if (!active(t) || !t.dueDate) return false;
  return now && now.date === today ? isPastDue(t.dueDate, t.dueTime, now) : t.dueDate < today;
}

/** Shows up in Today: overdue, due today, started already, or in progress. */
export function isToday(t: ViewTask, today: ISODate): boolean {
  if (!active(t)) return false;
  if (t.status === 'doing') return true;
  if (t.dueDate && t.dueDate <= today) return true;
  if (t.startDate && t.startDate <= today) return true;
  return false;
}

export function matchesView(t: ViewTask, view: ViewName, today: ISODate, now?: Clock | null): boolean {
  switch (view) {
    case 'today':
      return isToday(t, today);
    case 'overdue':
      return isOverdue(t, today, now);
    case 'upcoming': {
      if (!active(t)) return false;
      const first = t.startDate ?? t.dueDate;
      return !!first && first > today;
    }
    case 'inbox':
      return active(t) && t.projectId === null;
    case 'unscheduled':
      return active(t) && !t.startDate && !t.dueDate;
    case 'all':
      return active(t);
    case 'done':
      return t.status === 'done';
  }
}

/** The moment a task is ordered by: its due date and time, else its start. */
function whenKey(t: ViewTask): string | null {
  if (t.dueDate) return dateTimeKey(t.dueDate, t.dueTime, 'end');
  if (t.startDate) return dateTimeKey(t.startDate, t.startTime, 'start');
  return null;
}

/** In progress first, then earliest due (by time within a day; a day without a time last), then priority, then manual order. */
export function compareTasks(a: ViewTask, b: ViewTask): number {
  const sa = a.status === 'doing' ? 0 : 1;
  const sb = b.status === 'doing' ? 0 : 1;
  if (sa !== sb) return sa - sb;
  const da = whenKey(a);
  const db = whenKey(b);
  if (da !== db) {
    if (!da) return 1;
    if (!db) return -1;
    return da < db ? -1 : 1;
  }
  if (a.priority !== b.priority) return b.priority - a.priority;
  if (a.position !== b.position) return a.position - b.position;
  return a.number - b.number;
}

export function compareDone(a: ViewTask, b: ViewTask): number {
  return (b.completedAt ?? '').localeCompare(a.completedAt ?? '');
}

export function selectView<T extends ViewTask>(tasks: readonly T[], view: ViewName, today: ISODate, now?: Clock | null): T[] {
  const out = tasks.filter((t) => matchesView(t, view, today, now));
  return out.sort(view === 'done' ? compareDone : compareTasks);
}
